/**
 * useDesktopDriveSync — the desktop (Tauri) wrapper around the shared
 * `useGoogleSync` hook. Owns the payload-signature signal and bridges the
 * SQLite library (via `cloudsyncDb`) to the Drive realm.
 *
 * v3 roles:
 *   - Layer 1 (metadata, favorites, ratings, resume positions, listening
 *     counters, playlists, tombstones) is always pushed.
 *   - Layer 2 (audio) is uploaded only for tracks the user marked offline (or
 *     when the audio policy is "all"), and downloaded only for tracks THIS
 *     device wants offline — never automatically for the whole library.
 *
 * Note on the sign-in origin: in development the Tauri window loads from
 * `http://localhost:1420` (see vite.config.ts / tauri.conf.json devUrl), so
 * that origin must be registered as an Authorized JavaScript origin. In
 * production the window uses `http://tauri.localhost` which must also be
 * registered. See docs/google-drive-sync.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setGoogleClientId, SYNC_SCOPE, cacheRefreshToken, getCachedRefreshToken, downloadAudioFile, clearAllDriveData, deleteDriveFile } from "@core/services/googleDriveSync";
import { Track } from "@core/models/Track";
import { LibraryManager } from "@core/services/LibraryManager";
import {
  useGoogleSync,
  type GoogleSyncStatus,
  type DriveAccount,
} from "./useGoogleSync";
import {
  buildDesktopSyncFile,
  applyDesktopEnvelope,
  getDesktopDeviceId,
} from "@core/services/cloudsyncDb";
import { DatabaseManager } from "@core/services/DatabaseManager";
import {
  songKeyOf,
  DEFAULT_AUDIO_MODE,
  isTombstoneExpired,
  unionAudioRequests,
  wantsAudioInDrive,
  type SyncTrackMeta,
  type MergedState,
  type Tombstone,
  type AudioMode,
} from "@core/services/cloudsync";

/** Configure the desktop build's client id (called once at startup). */
export function configureDesktopGoogleClientId(clientId: string): void {
  setGoogleClientId(clientId);
}

/** Cross-device state the UI may want to display. */
export interface MergedInfo {
  audioMode: AudioMode;
  /** Song keys that should have audio in Drive. */
  audioRequests: Set<string>;
  /** date → summed plays/seconds across all devices. */
  playStats: Map<string, { count: number; seconds: number }>;
  /** songKey → stars (LWW). */
  ratings: Map<string, number>;
  /** songKey → resume position (LWW). */
  positions: Map<string, number>;
  /** Every synced track (with or without audio) from the last merge. */
  tracks: SyncTrackMeta[];
}

export interface DesktopDriveSync {
  status: GoogleSyncStatus;
  account: DriveAccount | null;
  signedIn: boolean;
  hasConfig: boolean;
  signIn: () => void;
  signOut: () => void;
  runSync: () => void;
  /** Push this device's file (metadata + any permitted audio). */
  upload: () => void;
  /** Pull the merged state from Drive onto this device. */
  download: () => void;
  /** Permanently delete ALL Drive sync data + reset local sync state. */
  clean: () => Promise<void>;
  /** Record an explicit deletion (tombstone) so it propagates to other devices. */
  queueDeletion: (songKey: string) => void;
  ackDeletion: (songKey: string) => void;
  /** Mark a song as favorite-touched on this device (so LWW honors this toggle). */
  touchFavorite: (songKey: string) => void;
  /** Mark a playlist as edited on this device (so LWW honors this change). */
  touchPlaylist: (playlistId: string) => void;
  /** Set a rating (writes SQLite + stamps the LWW timestamp). */
  setRating: (songKey: string, stars: number) => Promise<void>;
  /** Record where playback stopped (writes SQLite + stamps the LWW timestamp). */
  setResumePosition: (songKey: string, secs: number) => Promise<void>;
  /** Change the global audio-upload policy. */
  setAudioMode: (mode: AudioMode) => void;
  /** Ask Drive to hold this song's audio (and keep a copy on this device). */
  setTrackOffline: (songKey: string, offline: boolean) => void;
  /** Ask Drive to hold every track of a playlist. */
  setPlaylistOffline: (playlistId: string, offline: boolean) => Promise<void>;
  /** Download ONE Drive-backed track into this library right now. */
  downloadTrackToLibrary: (songKey: string) => Promise<boolean>;
  /**
   * THIS device's audio-upload policy — the value to bind a UI control to.
   * (Use `mergedInfo.audioMode` only for display: it round-trips through Drive,
   * so binding a select to it makes the choice snap back until the next sync.)
   */
  audioMode: AudioMode;
  /** Delete Drive audio for songs no longer requested; returns files removed. */
  reclaimDriveAudio: () => Promise<number>;
  /** Latest merged cross-device state (for the settings UI). */
  mergedInfo: MergedInfo;
}

interface Options {
  ready: boolean;
  tracks: Track[];
  /** Bump whenever playlists/favorites change so a Drive push is triggered. */
  changeVersion?: number;
  /** Called after cloud data was applied so the UI can refresh the library. */
  onSyncedApplied?: () => void | Promise<void>;
  /** Current CLIENT_ID for the OAuth screen (may be empty → needs-config). */
  clientId?: string;
  /** OAuth client secret (desktop only). Google insists on it at the token
   *  endpoint for this client even with PKCE. */
  clientSecret?: string;
}

const DRIVE_MAP_KEY = "needmusic:gdrive:uploaded";
const PENDING_DELETE_KEY = "needmusic:gdrive:pendingDeletes";
const FAV_TS_KEY = "needmusic:gdrive:desktopFavTs";
const PL_TS_KEY = "needmusic:gdrive:desktopPlaylistTs";
const RATING_TS_KEY = "needmusic:gdrive:desktopRatingTs";
const POS_TS_KEY = "needmusic:gdrive:desktopPositionTs";
const AUDIO_REQ_KEY = "needmusic:gdrive:audioRequests";
const AUDIO_MODE_KEY = "needmusic:gdrive:audioMode";
const AUDIO_MODE_TS_KEY = "needmusic:gdrive:audioModeTs";

function initTs(key: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}

/** Load the persisted songKey → driveFileId map (survives restarts). */
function initDriveMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRIVE_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/**
 * Local tombstones: songKey → deletedAt (ISO).
 * Legacy builds stored a bare `string[]`; those entries are stamped with the
 * upgrade time so the GC clock starts then.
 */
function initTombstones(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PENDING_DELETE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const now = new Date().toISOString();
      const out: Record<string, string> = {};
      for (const k of parsed) if (k) out[String(k)] = now;
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  } catch { return {}; }
}

function initSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}

/** Convert an ArrayBuffer to a base64 string (for IPC file writes). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useDesktopDriveSync({
  ready,
  tracks,
  changeVersion = 0,
  onSyncedApplied,
  clientId = "",
  clientSecret = "",
}: Options): DesktopDriveSync {
  // Make sure the shared layer knows the client id for this session (idempotent).
  useEffect(() => {
    if (clientId.trim()) setGoogleClientId(clientId.trim());
  }, [clientId]);

  // Bumped by every local sync-relevant edit (rating/position/offline/mode) so
  // the payload signature changes and a push is scheduled. Track objects are
  // mutated in place, so an array-identity check alone would miss these.
  const [localVersion, setLocalVersion] = useState(0);
  const bumpLocal = useCallback(() => setLocalVersion((v) => v + 1), []);

  /** Reflect data changes in a synchronously computed signature. */
  const signature = useMemo(
    () =>
      `${changeVersion}|${localVersion}|${tracks.map((t) => songKeyOf(t)).join("|")}|${tracks
        .map((t) => (t.isFavorite ? "1" : "0"))
        .join("")}`,
    [tracks, changeVersion, localVersion],
  );

  // Cache the last-known driveFileIds (songKey → driveFileId) so we don't
  // re-upload audio that already has a Drive copy. Persisted to localStorage so
  // the "already uploaded" knowledge survives app restarts.
  const knownDriveMapRef = useRef<Record<string, string>>(initDriveMap());
  // Explicit deletions (tombstones, persisted with timestamps).
  const tombstonesRef = useRef<Record<string, string>>(initTombstones());
  const persistTombstones = useCallback(() => {
    try { localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(tombstonesRef.current)); }
    catch { /* ignore */ }
  }, []);
  const queueDeletion = useCallback((songKey: string) => {
    if (!songKey) return;
    tombstonesRef.current[songKey] = new Date().toISOString();
    persistTombstones();
    bumpLocal();
  }, [persistTombstones, bumpLocal]);
  const ackDeletion = useCallback((songKey: string) => {
    if (tombstonesRef.current[songKey]) {
      delete tombstonesRef.current[songKey];
      persistTombstones();
    }
  }, [persistTombstones]);

  /** Tombstones not yet past the GC window (older ones stop propagating). */
  const activeTombstones = useCallback((): Tombstone[] => {
    const device = getDesktopDeviceId();
    const out: Tombstone[] = [];
    for (const [songKey, deletedAt] of Object.entries(tombstonesRef.current)) {
      const t: Tombstone = { songKey, deletedAt, deviceId: device };
      if (!isTombstoneExpired(t)) out.push(t);
    }
    return out;
  }, []);

  const persistDriveMap = useCallback(() => {
    try { localStorage.setItem(DRIVE_MAP_KEY, JSON.stringify(knownDriveMapRef.current)); }
    catch { /* ignore */ }
  }, []);

  // Per-key timestamps for favorites/playlists/ratings/positions so an
  // un-favorite / re-rate / re-seek keeps "winning" across devices (LWW).
  const favTsRef = useRef<Record<string, string>>(initTs(FAV_TS_KEY));
  const persistFavTs = useCallback(() => {
    try { localStorage.setItem(FAV_TS_KEY, JSON.stringify(favTsRef.current)); } catch { /* ignore */ }
  }, []);
  const playlistTsRef = useRef<Record<string, string>>(initTs(PL_TS_KEY));
  const persistPlaylistTs = useCallback(() => {
    try { localStorage.setItem(PL_TS_KEY, JSON.stringify(playlistTsRef.current)); } catch { /* ignore */ }
  }, []);
  const ratingTsRef = useRef<Record<string, string>>(initTs(RATING_TS_KEY));
  const persistRatingTs = useCallback(() => {
    try { localStorage.setItem(RATING_TS_KEY, JSON.stringify(ratingTsRef.current)); } catch { /* ignore */ }
  }, []);
  const posTsRef = useRef<Record<string, string>>(initTs(POS_TS_KEY));
  const persistPosTs = useCallback(() => {
    try { localStorage.setItem(POS_TS_KEY, JSON.stringify(posTsRef.current)); } catch { /* ignore */ }
  }, []);

  // ── Layer 2 policy ──────────────────────────────────────────────────────
  // Song keys that should have audio in Drive (this device's own picks plus the
  // merged union from every other device).
  const audioRequestsRef = useRef<Set<string>>(initSet(AUDIO_REQ_KEY));
  const persistAudioRequests = useCallback(() => {
    try { localStorage.setItem(AUDIO_REQ_KEY, JSON.stringify([...audioRequestsRef.current])); }
    catch { /* ignore */ }
  }, []);
  const [audioMode, setAudioModeState] = useState<AudioMode>(() => {
    try { return (localStorage.getItem(AUDIO_MODE_KEY) as AudioMode) || DEFAULT_AUDIO_MODE; }
    catch { return DEFAULT_AUDIO_MODE; }
  });
  const audioModeTsRef = useRef<string>(
    (() => { try { return localStorage.getItem(AUDIO_MODE_TS_KEY) || ""; } catch { return ""; } })(),
  );

  // Merged cross-device state, kept for the settings UI.
  const [mergedInfo, setMergedInfo] = useState<MergedInfo>(() => ({
    audioMode: DEFAULT_AUDIO_MODE,
    audioRequests: new Set<string>(),
    playStats: new Map<string, { count: number; seconds: number }>(),
    ratings: new Map<string, number>(),
    positions: new Map<string, number>(),
    tracks: [],
  }));

  const setAudioMode = useCallback((mode: AudioMode) => {
    const now = new Date().toISOString();
    audioModeTsRef.current = now;
    setAudioModeState(mode);
    try {
      localStorage.setItem(AUDIO_MODE_KEY, mode);
      localStorage.setItem(AUDIO_MODE_TS_KEY, now);
    } catch { /* ignore */ }
    bumpLocal();
  }, [bumpLocal]);

  const setTrackOffline = useCallback((songKey: string, offline: boolean) => {
    if (!songKey) return;
    if (offline) audioRequestsRef.current.add(songKey);
    else audioRequestsRef.current.delete(songKey);
    persistAudioRequests();
    bumpLocal();
  }, [persistAudioRequests, bumpLocal]);

  const readAudio = useCallback(async (path: string): Promise<{ bytes: Uint8Array; mime: string }> => {
    const dataUrl: string = await invoke("read_audio_file", { filePath: path });
    const idx = dataUrl.indexOf(";base64,");
    const mime = idx >= 0 ? dataUrl.slice(5, idx) : "audio/mpeg";
    const b64 = idx >= 0 ? dataUrl.slice(idx + 8) : "";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  }, []);

  // Last-pushed favorite state (songKey → boolean) — used to bump ts on change.
  const prevFavStateRef = useRef<Record<string, boolean>>({});

  // Audio references from the last merge (songKey → track meta), so our next
  // push keeps them even when the audio was uploaded by another device.
  const existingMetaRef = useRef<Map<string, SyncTrackMeta>>(new Map());

  /** Build THIS desktop device's sync file from the SQLite library. */
  const getOwnFile = useCallback(
    async (token: string) => {
      // Audio references known from the last merge (they may have been uploaded
      // by ANOTHER device) plus this device's own upload history. Passing them
      // in lets `buildDesktopSyncFile` skip re-uploading and keep the audio
      // metadata attached when it writes fresh Layer-1 metadata.
      const existingTracks: SyncTrackMeta[] = [];
      const seen = new Set<string>();
      for (const t of existingMetaRef.current.values()) {
        if (!t.driveFileId) continue;
        existingTracks.push(t);
        seen.add(t.songKey);
      }
      for (const [songKey, driveFileId] of Object.entries(knownDriveMapRef.current)) {
        if (seen.has(songKey)) continue;
        existingTracks.push({
          songKey, driveFileId,
          title: "", artist: "", album: "", durationSecs: 0, isFavorite: false,
        });
      }

      // Upload gate: our own offline marks PLUS the merged union, so a request
      // made on the PHONE still makes this device (which owns the file) upload
      // it. Without this the phone could ask forever and never receive audio.
      const allRequests = unionAudioRequests(audioRequestsRef.current, mergedInfo.audioRequests);

      const file = await buildDesktopSyncFile(token, readAudio, existingTracks, {
        tombstones: activeTombstones(),
        favTs: favTsRef.current,
        ratingTs: ratingTsRef.current,
        positionTs: posTsRef.current,
        playlistTs: playlistTsRef.current,
        prevFavState: prevFavStateRef.current,
        audioRequests: allRequests,
        audioMode,
        audioModeTs: audioModeTsRef.current || undefined,
      });
      persistFavTs();
      persistRatingTs();
      persistPosTs();
      // Remember the favorite state we just pushed (for change-detection).
      prevFavStateRef.current = {};
      for (const f of file.favorites) prevFavStateRef.current[f.songKey] = f.fav;
      // Remember the audio refs we just produced.
      for (const t of file.tracks) {
        if (t.driveFileId) knownDriveMapRef.current[t.songKey] = t.driveFileId;
      }
      // Forget ids we no longer publish (deleted/tombstoned, or a stale id that
      // turned out to be gone from Drive) so the map can't keep resurrecting a
      // dead reference on every push.
      const published = new Set<string>();
      for (const t of file.tracks) if (t.driveFileId) published.add(t.songKey);
      for (const key of Object.keys(knownDriveMapRef.current)) {
        if (!published.has(key)) delete knownDriveMapRef.current[key];
      }
      persistDriveMap();
      return file;
    },
    [readAudio, persistDriveMap, persistFavTs, persistRatingTs, persistPosTs, activeTombstones, audioMode, mergedInfo.audioRequests],
  );

  /** Mark a songKey as favorite-touched on this device (stamps now). */
  const touchFavorite = useCallback((songKey: string) => {
    favTsRef.current[songKey] = new Date().toISOString();
    persistFavTs();
  }, [persistFavTs]);

  /** Mark a playlist as edited on this device (stamps now). */
  const touchPlaylist = useCallback((playlistId: string) => {
    playlistTsRef.current[playlistId] = new Date().toISOString();
    persistPlaylistTs();
  }, [persistPlaylistTs]);

  /** Set a rating: writes SQLite and stamps this device as the LWW writer. */
  const setRating = useCallback(async (songKey: string, stars: number) => {
    if (!songKey) return;
    const db = DatabaseManager.getInstance();
    const value = Track.clampRating(stars);
    for (const t of LibraryManager.getInstance().getAllTracks()) {
      if (songKeyOf(t) === songKey) {
        await db.setRating(t.id, value);
        t.rating = value;
      }
    }
    ratingTsRef.current[songKey] = new Date().toISOString();
    persistRatingTs();
    bumpLocal();
  }, [persistRatingTs, bumpLocal]);

  /** Record the playback position: writes SQLite and stamps the LWW writer. */
  const setResumePosition = useCallback(async (songKey: string, secs: number) => {
    if (!songKey) return;
    const db = DatabaseManager.getInstance();
    const value = Number(secs) > 0 ? Number(secs) : 0;
    for (const t of LibraryManager.getInstance().getAllTracks()) {
      if (songKeyOf(t) === songKey) {
        await db.setResumePosition(t.id, value);
        t.resumePositionSecs = value;
      }
    }
    posTsRef.current[songKey] = new Date().toISOString();
    persistPosTs();
    bumpLocal();
  }, [persistPosTs, bumpLocal]);

  /** Mark a whole playlist's tracks as wanted offline (or not). */
  const setPlaylistOffline = useCallback(async (playlistId: string, offline: boolean) => {
    const db = DatabaseManager.getInstance();
    const pts = await db.getPlaylistTracks(playlistId);
    for (const t of pts) {
      const key = songKeyOf(t);
      if (offline) audioRequestsRef.current.add(key);
      else audioRequestsRef.current.delete(key);
    }
    persistAudioRequests();
    bumpLocal();
  }, [persistAudioRequests, bumpLocal]);

  /**
   * Materialize Drive-synced tracks THIS DEVICE WANTS into real local files
   * (download from Drive, write to disk, import). Only tracks the user marked
   * offline (or all tracks under the "all" policy) are downloaded — the old
   * behaviour of duplicating the entire library onto every device is gone.
   */
  const materializeDriveTracks = useCallback(
    async (token: string, newTracks: SyncTrackMeta[]): Promise<number> => {
      if (!token || !newTracks.length) return 0;
      const blocked = new Set(Object.keys(tombstonesRef.current));
      // Songs THIS device already has a Drive copy for are its own uploads.
      const alreadyUploaded = new Set(Object.keys(knownDriveMapRef.current));
      // Honours the local marks AND the merged union (see wantsAudioInDrive).
      const wanted = (k: string) =>
        wantsAudioInDrive(k, audioMode, audioRequestsRef.current, mergedInfo.audioRequests);
      const queued = newTracks.filter(
        (t) => !blocked.has(t.songKey) && !alreadyUploaded.has(t.songKey) && wanted(t.songKey),
      );
      if (!queued.length) return 0;
      let musicDir = "";
      try { musicDir = await invoke<string>("get_default_download_dir"); } catch { /* fall through */ }
      if (!musicDir) return 0;

      const lib = LibraryManager.getInstance();
      let imported = 0;
      for (const m of queued) {
        if (!m.driveFileId) continue;
        if (lib.getAllTracks().some((t) => songKeyOf(t) === m.songKey)) continue; // already local
        let bytes: ArrayBuffer;
        try { bytes = await downloadAudioFile(token, m.driveFileId!); }
        catch (e) { console.warn("[gdrive] audio download failed for", m.songKey, String(e)); continue; }
        const safeKey = m.songKey.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60);
        const dest = `${musicDir}${musicDir.endsWith("/") || musicDir.endsWith("\\") ? "" : "\\"}drive_${safeKey || "track"}.mp3`;
        let wrotePath = "";
        try {
          const base64 = arrayBufferToBase64(bytes);
          wrotePath = await invoke<string>("write_audio_file", { filePath: dest, dataBase64: base64 });
        } catch (e) { console.warn("[gdrive] write audio failed for", m.songKey, String(e)); continue; }
        try {
          const track = new Track({
            filePath: wrotePath,
            title: m.title || "Unknown",
            artist: m.artist || "Unknown Artist",
            album: m.album || "Unknown Album",
            albumArtist: m.albumArtist || m.artist || "Unknown Artist",
            durationSecs: m.durationSecs || 0,
            genre: m.genre || "",
            year: m.year ?? null,
            codec: Track.detectCodec(wrotePath),
            isFavorite: !!m.isFavorite,
            rating: mergedInfo.ratings.get(m.songKey) ?? 0,
            resumePositionSecs: mergedInfo.positions.get(m.songKey) ?? 0,
          });
          // Own audio file → not an online track; library stores the real path.
          await lib.addTrack(track);
          knownDriveMapRef.current[m.songKey] = m.driveFileId;
          imported++;
        } catch (e) { console.warn("[gdrive] failed to import", m.songKey, String(e)); }
      }
      if (imported > 0) persistDriveMap();
      return imported;
    },
    [persistDriveMap, audioMode, mergedInfo.audioRequests],
  );

  /** Apply a merged cross-device state into SQLite and refresh the app. */
  const onApplyMerged = useCallback(
    async (merged: MergedState, token: string) => {
      // Publish the merged Layer-2 state for the UI + materialization gating.
      setMergedInfo({
        audioMode: merged.audioMode,
        audioRequests: new Set(merged.audioRequests ?? []),
        playStats: merged.playStats,
        ratings: merged.ratings,
        positions: merged.positions,
        tracks: merged.tracks ?? [],
      });
      // Keep every known audio ref so our next push carries it forward.
      const meta = new Map<string, SyncTrackMeta>();
      for (const t of merged.tracks ?? []) {
        if (t.driveFileId) meta.set(t.songKey, t);
      }
      existingMetaRef.current = meta;
      // Cross-device listening totals are stored separately from the
      // device-local counters we publish, so merged numbers can never be fed
      // back into the payload (which would double-count them).
      try {
        await DatabaseManager.getInstance().replaceMergedPlayStats(merged.playStats);
        // Let the activity heatmap pick up the cross-device totals.
        window.dispatchEvent(new CustomEvent("listeningActivity"));
      } catch { /* stats are best-effort */ }

      let result: { changed: boolean; removed: { id: string; songKey: string; filePath: string; isOnline: boolean }[]; newTracks: SyncTrackMeta[] } = { changed: false, removed: [], newTracks: [] };
      try {
        result = await applyDesktopEnvelope(merged);
      } catch (e) { console.warn("[gdrive] apply merged failed", String(e)); }
      if (result.removed.length) {
        for (const t of result.removed) {
          if (!t.isOnline) {
            try { await invoke("delete_track_file", { filePath: t.filePath }); }
            catch { /* file may already be gone — metadata already removed */ }
          }
          if (knownDriveMapRef.current[t.songKey]) delete knownDriveMapRef.current[t.songKey];
          if (tombstonesRef.current[t.songKey]) {
            delete tombstonesRef.current[t.songKey];
            persistTombstones();
          }
        }
        persistDriveMap();
      }
      if (result.newTracks.length) {
        try { await materializeDriveTracks(token, result.newTracks); } catch (e) { console.warn("[gdrive] materialize failed", String(e)); }
      }
      if (result.changed) await onSyncedApplied?.();
    },
    [onSyncedApplied, persistDriveMap, persistTombstones, materializeDriveTracks],
  );

  /**
   * System-browser OAuth (PKCE) via the Rust backend — used because the desktop
   * app's origin can't be an Authorized JS origin for Google's inline GIS flow.
   * Opens the OS browser, polls the loopback callback for the code, and returns
   * the exchanged access token (or "" on timeout/cancel).
   *
   * The desktop uses a full OIDC authorization-code flow (`openid email profile`
   * + `drive.appdata`). Google's "/o/oauth2/v2/auth" treats a Web-app client with
   * `response_type=code` + `openid` as a standard OIDC flow, which avoids the
   * "Required parameter is missing: response_type" that some pure-API scopes
   * trigger on this endpoint.
   */
  const browserAuth = useCallback(async (reqClientId: string): Promise<string> => {
    const scope = `openid email profile ${SYNC_SCOPE}`;
    let authUrl = "";
    try {
      authUrl = await invoke<string>("google_oauth_start", { clientId: reqClientId, scope, clientSecret });
    } catch (e: any) {
      throw new Error(`Couldn't start authorization: ${String(e?.message || e)}`);
    }
    if (!authUrl) throw new Error("Authorization could not be started.");
    // Open the auth URL with the Tauri shell plugin — the reliable cross-platform
    // way to hand a URL (including its `&` params) to the default browser.
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(authUrl);
    } catch (e: any) {
      throw new Error(`Couldn't open the browser: ${String(e?.message || e)}`);
    }
    // Poll the loopback callback for up to ~3 minutes (the Rust side exchanges
    // the code and returns the token; busy-waiting is fine at 1s cadence).
    for (let i = 0; i < 180; i++) {
      try {
        const raw = await invoke<string>("google_oauth_poll", { clientId: reqClientId, clientSecret });
        if (raw) {
          // `raw` is `{"access_token": "...", "refresh_token": "..."}`.
          const parsed = JSON.parse(raw);
          if (parsed.refresh_token) cacheRefreshToken(parsed.refresh_token);
          return parsed.access_token || "";
        }
      } catch (e: any) {
        throw new Error(`Authorization failed: ${String(e?.message || e)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { await invoke("google_oauth_clear"); } catch { /* ignore */ }
    return "";
  }, [clientSecret]);

  /** Silent renewal via the stored refresh token (Rust backend). */
  const refreshTokenProvider = useCallback(async (): Promise<string> => {
    const rt = getCachedRefreshToken();
    if (!rt) throw new Error("no refresh token");
    return await invoke<string>("google_oauth_refresh", {
      clientId,
      clientSecret,
      refreshToken: rt,
    });
  }, [clientId, clientSecret]);

  const hook = useGoogleSync({
    ready,
    deviceId: getDesktopDeviceId(),
    getOwnFile,
    onApplyMerged,
    payloadSignature: signature,
    browserAuth,
    refreshAccessToken: refreshTokenProvider,
  });

  /**
   * Download ONE Drive-backed track into this device's library right now, and
   * mark it wanted-offline so it stays available. This is the desktop's
   * "download this track to my device" action for songs that exist in Drive but
   * not yet in this library.
   */
  const downloadTrackToLibrary = useCallback(async (songKey: string): Promise<boolean> => {
    const token = hook.token;
    if (!token || !songKey) return false;
    const meta = mergedInfo.tracks.find((t) => t.songKey === songKey && t.driveFileId);
    if (!meta) return false;
    // Ask for it first: materializeDriveTracks only fetches tracks we want.
    audioRequestsRef.current.add(songKey);
    persistAudioRequests();
    bumpLocal();
    const imported = await materializeDriveTracks(token, [meta]);
    if (imported > 0) await onSyncedApplied?.();
    return imported > 0;
  }, [hook.token, mergedInfo.tracks, materializeDriveTracks, persistAudioRequests, bumpLocal, onSyncedApplied]);

  /**
   * Delete Drive audio for songs that are no longer requested by ANY device and
   * whose tombstone (if any) has expired — reclaiming the user's Drive quota.
   * Returns the number of files removed.
   */
  const reclaimDriveAudio = useCallback(async (): Promise<number> => {
    const token = hook.token;
    if (!token) return 0;
    const db = DatabaseManager.getInstance();
    const all = await db.getAllTracks();
    const localKeys = new Set(all.map((t) => songKeyOf(t)));
    const keep = new Set([...audioRequestsRef.current, ...mergedInfo.audioRequests]);
    let removed = 0;
    for (const [songKey, fileId] of Object.entries(knownDriveMapRef.current)) {
      const stillLocal = localKeys.has(songKey);
      const stillWanted = keep.has(songKey) || audioMode === "all";
      // Only reclaim audio whose song is gone AND that nobody asked to keep.
      if (stillLocal || stillWanted) continue;
      try {
        await deleteDriveFile(token, fileId);
        delete knownDriveMapRef.current[songKey];
        removed++;
      } catch (e) { console.warn("[gdrive] reclaim failed for", songKey, String(e)); }
    }
    if (removed) persistDriveMap();
    return removed;
  }, [hook.token, mergedInfo.audioRequests, audioMode, persistDriveMap]);

  // Permanently delete ALL Drive sync data + reset this device's local sync
  // state + wipe the local library and its audio files (user-chosen "clean
  // everything"). Very destructive; callers must confirm with the user first.
  const clean = useCallback(async (): Promise<void> => {
    // 1) Remove every track from the local library + delete its audio file.
    const lib = LibraryManager.getInstance();
    const all = lib.getAllTracks();
    for (const t of all) {
      if (!t.isOnlineTrack()) {
        try { await invoke("delete_track_file", { filePath: t.filePath }); }
        catch { /* file already gone / not deletable — DB row still removed */ }
      }
      await lib.removeTrack(t.id);
    }
    await onSyncedApplied?.();

    const clearLocalAuth = () => {
      knownDriveMapRef.current = {};
      persistDriveMap();
      tombstonesRef.current = {};
      persistTombstones();
      favTsRef.current = {};
      persistFavTs();
      playlistTsRef.current = {};
      persistPlaylistTs();
      ratingTsRef.current = {};
      persistRatingTs();
      posTsRef.current = {};
      persistPosTs();
      audioRequestsRef.current = new Set();
      persistAudioRequests();
      hook.signOut();
    };
    try {
      if (hook.token) await clearAllDriveData(hook.token, clearLocalAuth);
      else clearLocalAuth();
    } catch (e: any) {
      // Token may be expired — still clear local state, but surface the error.
      clearLocalAuth();
      throw e;
    }
  }, [hook, persistDriveMap, persistTombstones, persistFavTs, persistPlaylistTs, persistRatingTs, persistPosTs, persistAudioRequests, onSyncedApplied]);

  return {
    status: hook.status,
    account: hook.account,
    signedIn: hook.signedIn,
    hasConfig: hook.hasConfig,
    signIn: () => { void hook.signIn(); },
    signOut: hook.signOut,
    runSync: () => { void hook.runSync(); },
    upload: () => { void hook.upload(); },
    download: () => { void hook.download(); },
    clean,
    queueDeletion,
    ackDeletion,
    touchFavorite,
    touchPlaylist,
    setRating,
    setResumePosition,
    setAudioMode,
    setTrackOffline,
    setPlaylistOffline,
    downloadTrackToLibrary,
    reclaimDriveAudio,
    mergedInfo,
    audioMode,
  };
}
