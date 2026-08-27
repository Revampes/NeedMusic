/**
 * cloudsyncDb — desktop (Tauri) side of the cross-device song-key sync.
 *
 * Builds a Drive envelope from the local SQLite library and applies an
 * incoming envelope back into it:
 *   - favorites are merged monotonically (spot-adding) by matching each local
 *     track's song key against the cloud's favorite song keys;
 *   - custom playlists are upserted by song key (resolved to local track ids),
 *     rebuilding the playlist_tracks rows of each synced playlist.
 *
 * It relies on the shared `cloudsync` (song-key logic) and `googleDriveSync`
 * (Drive transport + envelope types) modules, and on `DatabaseManager`.
 */

import { DatabaseManager } from "./DatabaseManager";
import {
  songKeyOf,
  type SyncableState,
  type SyncTrackMeta,
} from "./cloudsync";
import { uploadAudioFile } from "./googleDriveSync";
import type { DriveSyncEnvelope } from "./googleDriveSync";

/** Stable per-desktop-device id (WebView2 localStorage; unique vs web build). */
function getDesktopDeviceId(): string {
  const K = "needmusic:gdrive:desktopDeviceId";
  try {
    let id = localStorage.getItem(K);
    if (!id) {
      id = `desk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(K, id);
    }
    return id;
  } catch {
    return `desk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Build the envelope describing the *desktop* local state (from SQLite).
 *  Also uploads audio for local tracks that don't yet have a Drive copy, so the
 *  resulting `tracks` carry `driveFileId` references for playback on other
 *  devices. `readAudio(path)` reads a local file's bytes (+ mime); it is
 *  provided by the Tauri UI layer (keeps this core module free of @tauri deps). */
export async function buildDesktopEnvelope(
  token: string,
  readAudio: (path: string) => Promise<{ bytes: Uint8Array; mime: string }>,
  existingTracks?: SyncTrackMeta[],
): Promise<DriveSyncEnvelope> {
  const db = DatabaseManager.getInstance();
  const tracks = await db.getAllTracks();

  // Keep whatever driveFileIds we already know (avoid re-uploading).
  const driveFileByKey = new Map<string, string>();
  for (const t of existingTracks ?? []) {
    if (t.driveFileId) driveFileByKey.set(t.songKey, t.driveFileId);
  }

  const syncTracks: SyncTrackMeta[] = [];
  for (const local of tracks) {
    const songKey = songKeyOf(local);
    let driveFileId = driveFileByKey.get(songKey);
    if (!driveFileId && local.isOnlineTrack?.() !== true) {
      // No Drive copy yet (and it's a real local file): upload it.
      try {
        const { bytes, mime } = await readAudio(local.filePath);
        const driveName = `audio__${hashString(songKey)}.bin`;
        driveFileId = await uploadAudioFile(token, driveName, bytes, mime);
      } catch (e) {
        // Log & continue without audio; metadata still syncs.
        console.warn("[cloudsync] audio upload failed for", local.filePath, String(e));
      }
    }
    syncTracks.push({
      songKey,
      title: local.title,
      artist: local.artist,
      album: local.album,
      albumArtist: local.albumArtist || undefined,
      durationSecs: local.durationSecs || 0,
      genre: local.genre || undefined,
      year: local.year,
      codec: local.codec,
      isFavorite: !!local.isFavorite,
      driveFileId,
    });
  }

  const favorites = syncTracks.filter((t) => t.isFavorite).map((t) => t.songKey);

  const playlistsMeta = await db.getAllPlaylists();
  const playlists: SyncableState["playlists"] = [];
  for (const p of playlistsMeta) {
    if (p.id === "__favorites__") continue; // favorites are captured above
    const ptracks = await db.getPlaylistTracks(p.id);
    playlists.push({ id: p.id, name: p.name, trackKeys: ptracks.map((t) => songKeyOf(t)) });
  }

  return {
    lastUpdated: new Date().toISOString(),
    deviceId: getDesktopDeviceId(),
    payload: { favorites, playlists, tracks: syncTracks },
  };
}

/** Simple stable hash for naming audio files in Drive (songKey → hex). */
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Resolve cloud song keys back to local track ids against the given tracks. */
function resolveKeysToLocalIds(
  tracks: { id: string; title: string; artist: string; album: string; durationSecs: number }[],
  keys: string[],
): string[] {
  const byKey = new Map<string, string>();
  for (const t of tracks) {
    const k = songKeyOf(t);
    if (!byKey.has(k)) byKey.set(k, t.id);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const k of keys || []) {
    const id = byKey.get(k);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Apply an incoming (resolved) envelope into the desktop SQLite library.
 * Favorites are only ever added locally (spot-merge) so two devices don't
 * fight over a heart. Custom playlists are upserted and their rows rebuilt.
 * Returns true if anything changed.
 */
export async function applyDesktopEnvelope(envelope: DriveSyncEnvelope): Promise<boolean> {
  const db = DatabaseManager.getInstance();
  const state = (envelope.payload ?? {}) as SyncableState;
  let changed = false;

  // 1) Favorites: mark local tracks whose song key is in the cloud's set.
  const favKeys = new Set(state.favorites ?? []);
  if (favKeys.size > 0) {
    const tracks = await db.getAllTracks();
    for (const t of tracks) {
      if (favKeys.has(songKeyOf(t)) && !t.isFavorite) {
        await db.setFavorite(t.id, true);
        changed = true;
      }
    }
  }

  // 2) Custom playlists: upsert + rebuild rows by resolved local track ids.
  for (const pl of state.playlists ?? []) {
    const tracks = await db.getAllTracks();
    const ids = resolveKeysToLocalIds(tracks, pl.trackKeys ?? []);
    const all = await db.getAllPlaylists();
    if (!all.some((p) => p.id === pl.id)) {
      if (pl.id === "__favorites__") continue; // never create the special one
      await db.createPlaylist(pl.id, pl.name || pl.id);
    }
    if (pl.id !== "__favorites__") {
      // Rebuild this playlist's membership from the resolved ids.
      await db.replacePlaylistTracks(pl.id, ids);
      changed = true;
    }
  }

  return changed;
}
