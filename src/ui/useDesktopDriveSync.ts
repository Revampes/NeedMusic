/**
 * useDesktopDriveSync — the desktop (Tauri) wrapper around the shared
 * `useGoogleSync` hook. Owns the payload-signature signal and bridges the
 * SQLite library (via `cloudsyncDb`) to the Drive realm.
 *
 * Note on the sign-in origin: in development the Tauri window loads from
 * `http://localhost:1420` (see vite.config.ts / tauri.conf.json devUrl), so
 * that origin must be registered as an Authorized JavaScript origin. In
 * production the window uses `http://tauri.localhost` which must also be
 * registered. See docs/google-drive-sync.md.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setGoogleClientId, SYNC_SCOPE, cacheRefreshToken, getCachedRefreshToken, downloadAudioFile, clearAllDriveData } from "@core/services/googleDriveSync";
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
import { songKeyOf, type SyncTrackMeta, type MergedState } from "@core/services/cloudsync";

/** Configure the desktop build's client id (called once at startup). */
export function configureDesktopGoogleClientId(clientId: string): void {
  setGoogleClientId(clientId);
}

export interface DesktopDriveSync {
  status: GoogleSyncStatus;
  account: DriveAccount | null;
  signedIn: boolean;
  hasConfig: boolean;
  signIn: () => void;
  signOut: () => void;
  runSync: () => void;
  /** Push this device's tracks to Drive. */
  upload: () => void;
  /** Pull tracks from Drive onto this device. */
  download: () => void;
  /** Permanently delete ALL Drive sync data + reset local sync state. */
  clean: () => Promise<void>;
  /** Record an explicit deletion so it propagates to Drive/other devices. */
  queueDeletion: (songKey: string) => void;
  ackDeletion: (songKey: string) => void;
  /** Mark a song as favorite-touched on this device (so LWW honors this toggle). */
  touchFavorite: (songKey: string) => void;
  /** Mark a playlist as edited on this device (so LWW honors this change). */
  touchPlaylist: (playlistId: string) => void;
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

function initPendingDeletes(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PENDING_DELETE_KEY) || "[]")); }
  catch { return new Set(); }
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

  /** Reflect data changes in a synchronously computed signature. */
  const signature = useMemo(
    () =>
      `${changeVersion}|${tracks.map((t) => songKeyOf(t)).join("|")}|${tracks
        .map((t) => (t.isFavorite ? "1" : "0"))
        .join("")}`,
    [tracks, changeVersion],
  );

  // Cache the last-known driveFileIds (songKey → driveFileId) so we don't
  // re-upload audio that already has a Drive copy. Persisted to localStorage so
  // the "already uploaded" knowledge survives app restarts (second login onward
  // only uploads NEW/changed files → the sync is nearly instant).
  const knownDriveMapRef = useRef<Record<string, string>>(initDriveMap());
  // Explicit deletions queued on this device (persisted) — propagated to Drive,
  // never inferred by diff.
  const pendingDeletesRef = useRef<Set<string>>(initPendingDeletes());
  const persistPendingDeletes = useCallback(() => {
    try { localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify([...pendingDeletesRef.current])); }
    catch { /* ignore */ }
  }, []);
  const queueDeletion = useCallback((songKey: string) => {
    if (!songKey) return;
    pendingDeletesRef.current.add(songKey);
    persistPendingDeletes();
  }, [persistPendingDeletes]);
  const ackDeletion = useCallback((songKey: string) => {
    if (pendingDeletesRef.current.delete(songKey)) persistPendingDeletes();
  }, [persistPendingDeletes]);

  const persistDriveMap = useCallback(() => {
    try { localStorage.setItem(DRIVE_MAP_KEY, JSON.stringify(knownDriveMapRef.current)); }
    catch { /* ignore */ }
  }, []);

  // Per-key timestamps for favorites/playlists so an un-favorite/un-add keeps
  // "winning" across devices deterministically (last-writer-wins).
  const favTsRef = useRef<Record<string, string>>(initTs(FAV_TS_KEY));
  const persistFavTs = useCallback(() => {
    try { localStorage.setItem(FAV_TS_KEY, JSON.stringify(favTsRef.current)); } catch { /* ignore */ }
  }, []);
  const playlistTsRef = useRef<Record<string, string>>(initTs(PL_TS_KEY));
  const persistPlaylistTs = useCallback(() => {
    try { localStorage.setItem(PL_TS_KEY, JSON.stringify(playlistTsRef.current)); } catch { /* ignore */ }
  }, []);

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

  /** Build THIS desktop device's sync file from the SQLite library. */
  const getOwnFile = useCallback(
    async (token: string) => {
      // Build existing file-ids list from the persisted map.
      const existingTracks: SyncTrackMeta[] = Object.entries(knownDriveMapRef.current).map(
        ([songKey, driveFileId]) => ({ songKey, driveFileId, title: "", artist: "", album: "", durationSecs: 0, isFavorite: false })
      );
      const file = await buildDesktopSyncFile(token, readAudio, existingTracks, {
        pendingDeletes: pendingDeletesRef.current,
        favTs: favTsRef.current,
        playlistTs: playlistTsRef.current,
        prevFavState: prevFavStateRef.current,
      });
      // buildDesktopSyncFile may have bumped some favTs to now (state changed);
      // persist it so the next push keeps those new timestamps.
      persistFavTs();
      // Remember the favorite state we just pushed (for change-detection).
      prevFavStateRef.current = {};
      for (const f of file.favorites) prevFavStateRef.current[f.songKey] = f.fav;
      // Remember the driveFileIds we just produced and persist them.
      for (const t of file.tracks) if (t.driveFileId) knownDriveMapRef.current[t.songKey] = t.driveFileId;
      persistDriveMap();
      return file;
    },
    [readAudio, persistDriveMap, persistFavTs],
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

  /**
   * Materialize Drive-synced tracks (that aren't in the local library yet) as
   * real audio files in the user's music folder, then import them: download the
   * audio bytes from Drive, write them to disk, and `LibraryManager.addTrack`.
   * This is the receiving side of "add a track on device A → device B adds it
   * AND auto-downloads its audio". We skip any that fail to download so the rest
   * still sync. Returns the number of tracks successfully imported.
   */
  const materializeDriveTracks = useCallback(
    async (token: string, newTracks: SyncTrackMeta[]): Promise<number> => {
      if (!token || !newTracks.length) return 0;
      // Never materialize a track the user deleted (even if it's still present
      // in the drive envelope from before the deletion propagated).
      const blocked = new Set(pendingDeletesRef.current);
      // Also skip songs THIS device already has a Drive copy for (in the upload
      // map). Those are tracks this device itself uploaded/synced — if the local
      // file is missing we must NOT silently re-download them as `drive_*`
      // ghost duplicates every sync.
      const alreadyUploaded = new Set(Object.keys(knownDriveMapRef.current));
      const queued = newTracks.filter((t) => !blocked.has(t.songKey) && !alreadyUploaded.has(t.songKey));
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
    [persistDriveMap],
  );

  /** Apply a merged cross-device state into SQLite, delete removed audio files,
   *  auto-download + import new Drive tracks, and refresh the app. */
  const onApplyMerged = useCallback(
    async (merged: MergedState, token: string) => {
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
          knownDriveMapRef.current[t.songKey] && delete knownDriveMapRef.current[t.songKey];
          if (pendingDeletesRef.current.delete(t.songKey)) persistPendingDeletes();
        }
        persistDriveMap();
      }
      if (result.newTracks.length) {
        try { await materializeDriveTracks(token, result.newTracks); } catch (e) { console.warn("[gdrive] materialize failed", String(e)); }
      }
      if (result.changed) await onSyncedApplied?.();
    },
    [onSyncedApplied, persistDriveMap, persistPendingDeletes, materializeDriveTracks],
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
      pendingDeletesRef.current.clear();
      persistPendingDeletes();
      favTsRef.current = {};
      persistFavTs();
      playlistTsRef.current = {};
      persistPlaylistTs();
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
  }, [hook, persistDriveMap, persistPendingDeletes, persistFavTs, persistPlaylistTs, onSyncedApplied]);

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
  };
}
