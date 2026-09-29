/**
 * useWebDriveSync — the WebApp-facing wrapper around useGoogleSync.
 *
 * Owns the per-device sync-file build (`getOwnFile`) and the merge-apply
 * (`onApplyMerged`) using the shared `DeviceSyncFile` model (v3).
 *
 * v3 roles:
 *   - Layer 1 (metadata, favorites, ratings, resume positions, playlists,
 *     tombstones) is always pushed — even for tracks whose audio is not on
 *     Drive, which is what makes "track references" sync cheaply.
 *   - Layer 2 (audio) is uploaded only for tracks the user marked offline (or
 *     when the audio policy is "all"), and downloaded only for tracks THIS
 *     device wants offline.
 *
 * The web build has no SQLite and no local play-history table, so it publishes
 * no listening counters (the desktop's counters still reach every device).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackData } from "./bootstrap";
import {
  useGoogleSync,
  type GoogleSyncStatus,
  type DriveAccount,
} from "./useGoogleSync";
import type {
  DeviceSyncFile,
  FavRecord,
  PlaylistRecord,
  MergedState,
  SyncTrackMeta,
  Tombstone,
  RatingRecord,
  PositionRecord,
  AudioMode,
} from "@core/services/cloudsync";
import { songKeyOf, DEFAULT_AUDIO_MODE, isTombstoneExpired, unionAudioRequests, wantsAudioInDrive } from "@core/services/cloudsync";
import { uploadAudioFile, clearAllDriveData, getCachedToken } from "./GoogleDriveSync";
import { getDownloadedAudio, setDownloadedPinned } from "./downloads";
import { loadPlaylists, savePlaylists, type WebPlaylist } from "./playlistsStore";
import { getDeviceId, payloadSignature } from "./useDriveEnvelope";

/** Cross-device Layer-2 state the UI may want to display. */
export interface WebMergedInfo {
  audioMode: AudioMode;
  audioRequests: Set<string>;
  ratings: Map<string, number>;
  positions: Map<string, number>;
}

export interface WebDriveSync {
  status: GoogleSyncStatus;
  account: DriveAccount | null;
  signedIn: boolean;
  hasConfig: boolean;
  /** OAuth access token (for downloading Drive-audio for playback). */
  token: string;
  signIn: () => void;
  signOut: () => void;
  runSync: () => void;
  /** Push this device's file (metadata + any permitted audio). */
  upload: () => void;
  /** Pull the merged state from Drive onto this device. */
  download: () => void;
  /** Permanently delete ALL Drive sync data + reset local sync state. */
  clean: () => Promise<void>;
  /** Mark a track as explicitly deleted (tombstone) so it propagates. */
  queueDeletion: (songKey: string) => void;
  /** Mark a song as favorite-touched on this device. */
  touchFavorite: (songKey: string) => void;
  /** Mark a playlist as edited on this device. */
  touchPlaylist: (playlistId: string) => void;
  /** Stamp a rating change so this device wins the LWW comparison. */
  touchRating: (songKey: string) => void;
  /** Stamp a resume-position change so this device wins the LWW comparison. */
  touchPosition: (songKey: string) => void;
  /** Change the global audio-upload policy. */
  setAudioMode: (mode: AudioMode) => void;
  /** Ask Drive to hold this song's audio (and keep a local copy on this device). */
  setTrackOffline: (songKey: string, offline: boolean) => void;
  /** Ask Drive to hold every track of a playlist. */
  setPlaylistOffline: (playlistId: string, offline: boolean) => void;
  /** Latest merged cross-device state. */
  mergedInfo: WebMergedInfo;
  /**
   * THIS device's audio-upload policy — the value to bind a UI control to.
   * (`mergedInfo.audioMode` round-trips through Drive, so binding a select to it
   * makes the choice snap back until the next sync completes.)
   */
  audioMode: AudioMode;
}

interface Options {
  ready: boolean;
  tracks: TrackData[];
  /** Apply favorites (set-style, add+remove) from the merged state. */
  onSetFavorites: (favorites: Map<string, boolean>) => void;
  /** Called after playlists were merged from the cloud. */
  onPlaylistsMerged?: (playlists: WebPlaylist[]) => void;
  /** Called with merged ratings/positions so the UI can apply them. */
  onMergedTrackState?: (ratings: Map<string, number>, positions: Map<string, number>) => void;
  /** Called with synced drive-track metadata (to inject into the library) plus
   *  the merged Layer-2 state, so the host can decide what to download. */
  onDriveTracks?: (
    driveTracks: SyncTrackMeta[],
    merged: { audioMode: AudioMode; audioRequests: Set<string>; ratings: Map<string, number>; positions: Map<string, number> },
  ) => void;
  /** Called with EXPLICIT deletions from Drive to remove matching local tracks. */
  onDeletedTracks?: (deletedSongKeys: string[]) => void;
}

const PENDING_DELETE_KEY = "needmusic:gdrive:pendingDeletes";
const WEB_DRIVE_MAP_KEY = "needmusic:gdrive:webDriveMap";
const FAV_TS_KEY = "needmusic:gdrive:webFavTs";
const PL_TS_KEY = "needmusic:gdrive:webPlaylistTs";
const RATING_TS_KEY = "needmusic:gdrive:webRatingTs";
const POS_TS_KEY = "needmusic:gdrive:webPositionTs";
const AUDIO_REQ_KEY = "needmusic:gdrive:webAudioRequests";
const AUDIO_MODE_KEY = "needmusic:gdrive:webAudioMode";
const AUDIO_MODE_TS_KEY = "needmusic:gdrive:webAudioModeTs";

function initMap(key: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}

/**
 * Local tombstones: songKey → deletedAt (ISO).
 * Legacy builds stored a bare `string[]`; those entries get stamped with the
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
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
    }
    return out;
  } catch { return {}; }
}

function initSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}

function songHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function useWebDriveSync({
  ready,
  tracks,
  onSetFavorites,
  onPlaylistsMerged,
  onMergedTrackState,
  onDriveTracks,
  onDeletedTracks,
}: Options): WebDriveSync {
  const [playlistVersion, setPlaylistVersion] = useState(0);
  const [localVersion, setLocalVersion] = useState(0);
  const bumpLocal = useCallback(() => setLocalVersion((v) => v + 1), []);
  const onPlaylistsMergedRef = useRef(onPlaylistsMerged);
  onPlaylistsMergedRef.current = onPlaylistsMerged;
  const onDriveTracksRef = useRef(onDriveTracks);
  onDriveTracksRef.current = onDriveTracks;
  const onDeletedTracksRef = useRef(onDeletedTracks);
  onDeletedTracksRef.current = onDeletedTracks;
  const onSetFavoritesRef = useRef(onSetFavorites);
  onSetFavoritesRef.current = onSetFavorites;
  const onMergedTrackStateRef = useRef(onMergedTrackState);
  onMergedTrackStateRef.current = onMergedTrackState;

  const tombstonesRef = useRef<Record<string, string>>(initTombstones());
  const persistTombstones = useCallback(() => {
    try { localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(tombstonesRef.current)); }
    catch { /* ignore */ }
  }, []);
  const webDriveMapRef = useRef<Record<string, string>>(initMap(WEB_DRIVE_MAP_KEY));
  const persistWebMap = useCallback(() => {
    try { localStorage.setItem(WEB_DRIVE_MAP_KEY, JSON.stringify(webDriveMapRef.current)); }
    catch { /* ignore */ }
  }, []);
  const favTsRef = useRef<Record<string, string>>(initMap(FAV_TS_KEY));
  const persistFavTs = useCallback(() => {
    try { localStorage.setItem(FAV_TS_KEY, JSON.stringify(favTsRef.current)); } catch { /* ignore */ }
  }, []);
  const playlistTsRef = useRef<Record<string, string>>(initMap(PL_TS_KEY));
  const persistPlaylistTs = useCallback(() => {
    try { localStorage.setItem(PL_TS_KEY, JSON.stringify(playlistTsRef.current)); } catch { /* ignore */ }
  }, []);
  const ratingTsRef = useRef<Record<string, string>>(initMap(RATING_TS_KEY));
  const persistRatingTs = useCallback(() => {
    try { localStorage.setItem(RATING_TS_KEY, JSON.stringify(ratingTsRef.current)); } catch { /* ignore */ }
  }, []);
  const posTsRef = useRef<Record<string, string>>(initMap(POS_TS_KEY));
  const persistPosTs = useCallback(() => {
    try { localStorage.setItem(POS_TS_KEY, JSON.stringify(posTsRef.current)); } catch { /* ignore */ }
  }, []);

  // Layer-2 policy.
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
  const [mergedInfo, setMergedInfo] = useState<WebMergedInfo>(() => ({
    audioMode: DEFAULT_AUDIO_MODE,
    audioRequests: new Set<string>(),
    ratings: new Map<string, number>(),
    positions: new Map<string, number>(),
  }));
  const mergedInfoRef = useRef(mergedInfo);
  mergedInfoRef.current = mergedInfo;

  const queueDeletion = useCallback((songKey: string) => {
    if (!songKey) return;
    tombstonesRef.current[songKey] = new Date().toISOString();
    persistTombstones();
    bumpLocal();
  }, [persistTombstones, bumpLocal]);

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
    // Keep the local copy pinned so cache eviction can never drop it.
    void (async () => {
      for (const t of tracks) {
        if (songKeyOf(t) !== songKey) continue;
        try { await setDownloadedPinned(t.id, offline); } catch { /* not downloaded yet */ }
      }
    })();
    bumpLocal();
  }, [persistAudioRequests, bumpLocal, tracks]);

  const setPlaylistOffline = useCallback((playlistId: string, offline: boolean) => {
    const pl = loadPlaylists().find((p) => p.id === playlistId);
    if (!pl) return;
    const byId = new Map(tracks.map((t) => [t.id, t]));
    for (const id of pl.trackIds ?? []) {
      const t = byId.get(id);
      if (!t) continue;
      const key = songKeyOf(t);
      if (offline) audioRequestsRef.current.add(key);
      else audioRequestsRef.current.delete(key);
    }
    persistAudioRequests();
    bumpLocal();
  }, [persistAudioRequests, bumpLocal, tracks]);

  useEffect(() => {
    const bump = () => setPlaylistVersion((v) => v + 1);
    window.addEventListener("needmusic:playlists-changed", bump);
    return () => window.removeEventListener("needmusic:playlists-changed", bump);
  }, []);

  const deviceId = useMemo(() => getDeviceId(), []);

  const signature = useMemo(
    () => `${payloadSignature(tracks)}|${localVersion}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, playlistVersion, localVersion],
  );

  /** Mark a songKey as favorite-touched on this device (stamps now). */
  const touchFavorite = useCallback((songKey: string) => {
    if (!songKey) return;
    favTsRef.current[songKey] = new Date().toISOString();
    persistFavTs();
  }, [persistFavTs]);

  /** Mark a playlist as edited on this device (stamps now). */
  const touchPlaylist = useCallback((playlistId: string) => {
    if (!playlistId) return;
    playlistTsRef.current[playlistId] = new Date().toISOString();
    persistPlaylistTs();
  }, [persistPlaylistTs]);

  /** Stamp a rating change made on this device. */
  const touchRating = useCallback((songKey: string) => {
    if (!songKey) return;
    ratingTsRef.current[songKey] = new Date().toISOString();
    persistRatingTs();
    bumpLocal();
  }, [persistRatingTs, bumpLocal]);

  /** Stamp a resume-position change made on this device. */
  const touchPosition = useCallback((songKey: string) => {
    if (!songKey) return;
    posTsRef.current[songKey] = new Date().toISOString();
    persistPosTs();
    bumpLocal();
  }, [persistPosTs, bumpLocal]);

  /** Build THIS device's sync file from current web state. */
  const getOwnFile = useCallback(
    async (token: string): Promise<DeviceSyncFile> => {
      const now = new Date().toISOString();
      const map = webDriveMapRef.current;
      const tracksOut: SyncTrackMeta[] = [];
      // Upload gate: our own offline marks plus the merged union, so a request
      // made on the computer still makes this device upload its local copy.
      const allRequests = unionAudioRequests(audioRequestsRef.current, mergedInfoRef.current.audioRequests);

      for (const t of tracks) {
        const key = songKeyOf(t);
        if (tombstonesRef.current[key]) continue;
        let driveFileId = map[key];
        const isLocalImport = !t.id.startsWith("drive-");
        const wantsAudio = wantsAudioInDrive(key, audioMode, allRequests);

        // Upload locally-held audio only when the policy allows it.
        if (isLocalImport && !driveFileId && wantsAudio && token) {
          let blob: Blob | null = null;
          try { blob = await getDownloadedAudio(t.id); } catch { /* ignore */ }
          if (blob) {
            try {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              driveFileId = await uploadAudioFile(token, `audio__${songHash(key)}.bin`, bytes, blob.type || "audio/mpeg");
              map[key] = driveFileId;
            } catch (e) { console.warn("[gdrive] web upload failed", key, String(e)); }
          }
        }
        // Layer 1: metadata ALWAYS syncs (audio optional).
        tracksOut.push({
          songKey: key, title: t.title, artist: t.artist, album: t.album,
          albumArtist: t.albumArtist || undefined, durationSecs: t.durationSecs || 0,
          genre: t.genre || undefined, year: t.year ?? null,
          codec: t.codec || undefined, isFavorite: !!t.isFavorite,
          addedAt: t.dateAdded instanceof Date && !Number.isNaN(t.dateAdded.getTime())
            ? t.dateAdded.toISOString()
            : undefined,
          driveFileId,
          audioUploadedAt: driveFileId ? now : undefined,
          audioUploadedBy: driveFileId ? deviceId : undefined,
        });
      }
      persistWebMap();

      // Favorites → for any song the user touched on THIS device.
      const favKeys = new Set(Object.keys(favTsRef.current));
      const favorites: FavRecord[] = [];
      for (const t of tracks) {
        const key = songKeyOf(t);
        if (!favKeys.has(key)) continue; // not touched here
        favorites.push({ songKey: key, fav: !!t.isFavorite, ts: favTsRef.current[key] });
      }
      persistFavTs();

      // Ratings / resume positions → only songs this device touched.
      const ratings: RatingRecord[] = [];
      const positions: PositionRecord[] = [];
      for (const t of tracks) {
        const key = songKeyOf(t);
        if (ratingTsRef.current[key]) {
          ratings.push({ songKey: key, stars: Math.max(0, Math.min(5, Math.round(Number(t.rating) || 0))), ts: ratingTsRef.current[key] });
        }
        if (posTsRef.current[key]) {
          positions.push({ songKey: key, secs: Number(t.resumePositionSecs) || 0, ts: posTsRef.current[key] });
        }
      }

      // Playlists → only for playlists edited on THIS device.
      const playlists: PlaylistRecord[] = [];
      const localPls = loadPlaylists();
      for (const p of localPls) {
        if (!p.id || !p.name) continue;
        if (!playlistTsRef.current[p.id]) continue; // not edited here
        playlists.push({
          id: p.id,
          name: p.name,
          trackKeys: (p.trackIds ?? [])
            .map((id) => tracks.find((t) => t.id === id))
            .filter((t): t is TrackData => !!t)
            .map((t) => songKeyOf(t)),
          ts: playlistTsRef.current[p.id],
        });
      }

      // Tombstones still inside the GC window.
      const tombstones: Tombstone[] = [];
      for (const [songKey, deletedAt] of Object.entries(tombstonesRef.current)) {
        const tb: Tombstone = { songKey, deletedAt, deviceId };
        if (!isTombstoneExpired(tb)) tombstones.push(tb);
      }

      return {
        deviceId,
        updatedAt: now,
        version: 3,
        tracks: tracksOut,
        tombstones,
        favorites,
        ratings,
        positions,
        // The web build keeps no local listening counters, so it contributes
        // nothing here (the desktop's counters still reach every device).
        playStats: [],
        audioRequests: [...audioRequestsRef.current].sort(),
        audioMode,
        audioModeTs: audioModeTsRef.current || now,
        playlists,
      };
    },
    [tracks, deviceId, persistWebMap, persistFavTs, audioMode],
  );

  // Resolve a song key to a local track id (first match).
  const resolveLocalId = useCallback((key: string): string | undefined => {
    for (const t of tracks) if (songKeyOf(t) === key) return t.id;
    return undefined;
  }, [tracks]);

  /** Apply the merged cross-device state to web local state. */
  const onApplyMerged = useCallback(
    (merged: MergedState, _token: string) => {
      setMergedInfo({
        audioMode: merged.audioMode,
        audioRequests: new Set(merged.audioRequests ?? []),
        ratings: merged.ratings,
        positions: merged.positions,
      });

      // Favorites: pass the full map (incl. fav:false records) so un-favourites
      // are applied too. Only skip when there are NO records at all (first sync
      // with no device data yet → don't wipe local favourites).
      onSetFavoritesRef.current?.(merged.favorites ?? new Map<string, boolean>());
      for (const [k, v] of merged.favorites) {
        if (v && !favTsRef.current[k]) favTsRef.current[k] = new Date().toISOString();
      }
      persistFavTs();

      // Playlists: merged is authoritative (LWW per id); resolve keys→local ids.
      const mergedPls: WebPlaylist[] = (merged.playlists ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        trackIds: (p.trackKeys ?? []).map((k) => resolveLocalId(k)).filter((x): x is string => !!x),
      }));
      savePlaylists(mergedPls);
      onPlaylistsMergedRef.current?.(mergedPls);

      // Ratings + resume positions for the UI to apply onto its track objects.
      onMergedTrackStateRef.current?.(merged.ratings, merged.positions);

      // Drive-synced track metadata + explicit deletions. The merged Layer-2
      // state travels with the tracks so the host can gate audio downloads.
      onDriveTracksRef.current?.(merged.tracks ?? [], {
        audioMode: merged.audioMode,
        audioRequests: new Set(merged.audioRequests ?? []),
        ratings: merged.ratings,
        positions: merged.positions,
      });
      onDeletedTracksRef.current?.(merged.deletedTracks ?? []);
    },
    [persistFavTs, resolveLocalId],
  );

  const hook = useGoogleSync({
    ready,
    deviceId,
    getOwnFile,
    onApplyMerged,
    payloadSignature: signature,
  });

  const clean = useCallback(async (): Promise<void> => {
    const token = hook.token || getCachedToken();
    const clearLocalAuth = () => {
      webDriveMapRef.current = {};
      persistWebMap();
      favTsRef.current = {};
      persistFavTs();
      playlistTsRef.current = {};
      persistPlaylistTs();
      ratingTsRef.current = {};
      persistRatingTs();
      posTsRef.current = {};
      persistPosTs();
      tombstonesRef.current = {};
      persistTombstones();
      audioRequestsRef.current = new Set();
      persistAudioRequests();
      hook.signOut();
    };
    try {
      if (token) await clearAllDriveData(token, clearLocalAuth);
      else clearLocalAuth();
    } catch (e: any) {
      clearLocalAuth();
      throw e;
    }
  }, [hook, persistWebMap, persistFavTs, persistPlaylistTs, persistRatingTs, persistPosTs, persistTombstones, persistAudioRequests]);

  return {
    status: hook.status,
    account: hook.account,
    signedIn: hook.signedIn,
    hasConfig: hook.hasConfig,
    token: hook.token,
    signIn: () => { void hook.signIn(); },
    signOut: hook.signOut,
    runSync: () => { void hook.runSync(); },
    upload: () => { void hook.upload(); },
    download: () => { void hook.download(); },
    clean,
    queueDeletion,
    touchFavorite,
    touchPlaylist,
    touchRating,
    touchPosition,
    setAudioMode,
    setTrackOffline,
    setPlaylistOffline,
    mergedInfo,
    audioMode,
  };
}
