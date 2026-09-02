/**
 * useWebDriveSync — the WebApp-facing wrapper around useGoogleSync.
 *
 * Owns the per-device sync-file build (`getOwnFile`) and the merge-apply
 * (`onApplyMerged`) using the shared `DeviceSyncFile` model. Keeps WebApp.tsx
 * small.
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
} from "@core/services/cloudsync";
import { songKeyOf } from "@core/services/cloudsync";
import { uploadAudioFile, clearAllDriveData, getCachedToken } from "./GoogleDriveSync";
import { getDownloadedAudio } from "./downloads";
import { loadPlaylists, savePlaylists, type WebPlaylist } from "./playlistsStore";
import { getDeviceId, payloadSignature } from "./useDriveEnvelope";

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
  /** Push this device's tracks to Drive. */
  upload: () => void;
  /** Pull tracks from Drive onto this device. */
  download: () => void;
  /** Permanently delete ALL Drive sync data + reset local sync state. */
  clean: () => Promise<void>;
  /** Mark a track as explicitly deleted so it propagates to Drive. */
  queueDeletion: (songKey: string) => void;
  /** Mark a song as favorite-touched on this device. */
  touchFavorite: (songKey: string) => void;
  /** Mark a playlist as edited on this device. */
  touchPlaylist: (playlistId: string) => void;
}

interface Options {
  ready: boolean;
  tracks: TrackData[];
  /** Apply favorites (set-style, add+remove) from the merged state. */
  onSetFavorites: (favorites: Map<string, boolean>) => void;
  /** Called after playlists were merged from the cloud. */
  onPlaylistsMerged?: (playlists: WebPlaylist[]) => void;
  /** Called with synced drive-track metadata (to inject into the library). */
  onDriveTracks?: (driveTracks: SyncTrackMeta[]) => void;
  /** Called with EXPLICIT deletions from Drive to remove matching local tracks. */
  onDeletedTracks?: (deletedSongKeys: string[]) => void;
}

const PENDING_DELETE_KEY = "needmusic:gdrive:pendingDeletes";
const WEB_DRIVE_MAP_KEY = "needmusic:gdrive:webDriveMap";
const FAV_TS_KEY = "needmusic:gdrive:webFavTs";
const PL_TS_KEY = "needmusic:gdrive:webPlaylistTs";

function initSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}
function initMap(key: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
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
  onDriveTracks,
  onDeletedTracks,
}: Options): WebDriveSync {
  const [playlistVersion, setPlaylistVersion] = useState(0);
  const onPlaylistsMergedRef = useRef(onPlaylistsMerged);
  onPlaylistsMergedRef.current = onPlaylistsMerged;
  const onDriveTracksRef = useRef(onDriveTracks);
  onDriveTracksRef.current = onDriveTracks;
  const onDeletedTracksRef = useRef(onDeletedTracks);
  onDeletedTracksRef.current = onDeletedTracks;
  const onSetFavoritesRef = useRef(onSetFavorites);
  onSetFavoritesRef.current = onSetFavorites;

  const pendingDeletesRef = useRef<Set<string>>(initSet(PENDING_DELETE_KEY));
  const persistPending = useCallback(() => {
    try { localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify([...pendingDeletesRef.current])); }
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
  // Last-pushed favorite state (songKey → boolean) — used to bump ts on change.
  const prevFavStateRef = useRef<Record<string, boolean>>({});

  const queueDeletion = useCallback((songKey: string) => {
    if (songKey) { pendingDeletesRef.current.add(songKey); persistPending(); }
  }, [persistPending]);

  useEffect(() => {
    const bump = () => setPlaylistVersion((v) => v + 1);
    window.addEventListener("needmusic:playlists-changed", bump);
    return () => window.removeEventListener("needmusic:playlists-changed", bump);
  }, []);

  const deviceId = useMemo(() => getDeviceId(), []);

  const signature = useMemo(
    () => payloadSignature(tracks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, playlistVersion],
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

  /** Build THIS device's sync file from current web state, uploading any
   *  locally imported audio that isn't on Drive yet. */
  const getOwnFile = useCallback(
    async (token: string): Promise<DeviceSyncFile> => {
      const now = new Date().toISOString();
      const map = webDriveMapRef.current;
      const metaByKey = new Map<string, SyncTrackMeta>();

      // Upload local (non `drive-`) tracks that have persisted audio but no
      // Drive copy yet, and collect SyncTrackMeta for every local track.
      for (const t of tracks) {
        const key = songKeyOf(t);
        if (pendingDeletesRef.current.has(key)) continue;
        let driveFileId = map[key];
        const isLocalImport = !t.id.startsWith("drive-");
        if (isLocalImport && !driveFileId) {
          let blob: Blob | null = null;
          try { blob = await getDownloadedAudio(t.id); } catch { /* ignore */ }
          if (blob && token) {
            try {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              driveFileId = await uploadAudioFile(token, `audio__${songHash(key)}.bin`, bytes, blob.type || "audio/mpeg");
              map[key] = driveFileId;
            } catch (e) { console.warn("[gdrive] web upload failed", key, String(e)); }
          }
        }
        if (driveFileId) {
          metaByKey.set(key, {
            songKey: key, title: t.title, artist: t.artist, album: t.album,
            albumArtist: t.albumArtist || undefined, durationSecs: t.durationSecs || 0,
            genre: t.genre || undefined, year: t.year ?? null,
            codec: t.codec || undefined, isFavorite: !!t.isFavorite, driveFileId,
          });
        }
      }
      persistWebMap();

      // Favorites → for any song the user touched on THIS device (kept in
      // favTsRef), regardless of audio source. Untouched songs keep the favorite
      // set by whichever device owns them — this device must NOT override them.
      const favKeys = new Set(Object.keys(favTsRef.current));
      const prevFavState = prevFavStateRef.current;
      const favorites: FavRecord[] = [];
      for (const t of tracks) {
        const key = songKeyOf(t);
        if (!favKeys.has(key)) continue; // not touched here
        const changed = prevFavState[key] !== undefined && prevFavState[key] !== !!t.isFavorite;
        const ts = changed ? now : favTsRef.current[key];
        if (changed) favTsRef.current[key] = now; // keep for next push
        favorites.push({ songKey: key, fav: !!t.isFavorite, ts });
      }
      // Remember the favorite state we just pushed (for change-detection).
      prevFavStateRef.current = {};
      for (const f of favorites) prevFavStateRef.current[f.songKey] = f.fav;
      persistFavTs();

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

      return {
        deviceId,
        updatedAt: now,
        tracks: [...metaByKey.values()],
        deletedTracks: [...pendingDeletesRef.current].sort(),
        favorites,
        playlists,
      };
    },
    [tracks, deviceId, persistWebMap],
  );

  // Resolve a song key to a local track id (first match).
  const resolveLocalId = useCallback((key: string): string | undefined => {
    for (const t of tracks) if (songKeyOf(t) === key) return t.id;
    return undefined;
  }, [tracks]);

  /** Apply the merged cross-device state to web local state. */
  const onApplyMerged = useCallback(
    (merged: MergedState, _token: string) => {
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

      // Drive-synced track metadata + explicit deletions.
      onDriveTracksRef.current?.(merged.tracks ?? []);
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
      pendingDeletesRef.current.clear();
      persistPending();
      hook.signOut();
    };
    try {
      if (token) await clearAllDriveData(token, clearLocalAuth);
      else clearLocalAuth();
    } catch (e: any) {
      clearLocalAuth();
      throw e;
    }
  }, [hook, persistWebMap, persistFavTs, persistPlaylistTs, persistPending]);

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
  };
}
