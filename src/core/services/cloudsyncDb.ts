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
import { Track } from "@core/models/Track";
import {
  songKeyOf,
  DEFAULT_AUDIO_MODE,
  wantsAudioInDrive,
  unionAudioRequests,
  resolveAudioId,
  type AudioIdCache,
  type SyncTrackMeta,
  type DeviceSyncFile,
  type FavRecord,
  type PlaylistRecord,
  type MergedState,
  type Tombstone,
  type RatingRecord,
  type PositionRecord,
  type PlayStatRecord,
  type AudioMode,
} from "./cloudsync";
import { uploadAudioFile, appDataFileExists } from "./googleDriveSync";

/** How much listening history a device publishes (covers the yearly heatmap). */
const PLAY_STATS_DAYS = 400;

/* ─── Stale-audio detection ──────────────────────────────────────────────────
 * A recorded Drive file id can stop existing (e.g. "Clean everything" on
 * another device wipes the whole appDataFolder). Publishing a dead id makes
 * every other device fail with Google's "File not found", so each id is
 * verified ONCE per app run (see `resolveAudioId`): verified ids are trusted,
 * dead ones are forgotten, and the audio is re-uploaded if some device still
 * wants it.
 * ------------------------------------------------------------------------- */
const AUDIO_ID_CACHE: AudioIdCache = { verified: new Set(), dead: new Set() };

/** Stable per-desktop-device id (WebView2 localStorage; unique vs web build). */
export function getDesktopDeviceId(): string {
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

/** Simple stable hash for naming audio files in Drive (songKey → hex). */
export function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Build THIS desktop device's own sync file from SQLite state.
 *
 * Layer 1 (metadata, favorites, ratings, positions, play counters, playlists,
 * tombstones) is always included. Layer 2 (audio bytes) is uploaded ONLY when
 * the audio policy allows it:
 *   - `all`      → upload every local track's audio (full cloud backup)
 *   - `selected` → upload only tracks in `audioRequests` (offline-marked)
 *   - `none`     → never upload
 * Audio already on Drive is never re-uploaded, and a metadata write for a track
 * whose audio lives on Drive keeps its `driveFileId`.
 *
 * `readAudio(path)` reads a local file's bytes (+ mime); it is provided by the
 * Tauri UI layer to keep this core module free of @tauri deps.
 */
export async function buildDesktopSyncFile(
  token: string,
  readAudio: (path: string) => Promise<{ bytes: Uint8Array; mime: string }>,
  existingTracks?: SyncTrackMeta[],
  opts?: {
    /** Explicit deletions to keep propagating (persisted here; additive). */
    tombstones?: Tombstone[];
    /** Favorite change timestamps (songKey → ISO). Only keys the user has
     *  actually toggled on THIS device get records — untouched songs leave the
     *  LWW decision to the device(s) that own their records. */
    favTs?: Record<string, string>;
    /** Rating change timestamps (songKey → ISO). Same ownership rule. */
    ratingTs?: Record<string, string>;
    /** Resume-position timestamps (songKey → ISO). Same ownership rule. */
    positionTs?: Record<string, string>;
    /** Playlist edit timestamps (id → ISO). Same rule as favTs. */
    playlistTs?: Record<string, string>;
    /** Last-pushed favorite state (songKey → boolean). If the current state
     *  differs, this device bumps the favorite's ts to `now` (so an un-favorite
     *  "wins" LWW against another device's stale favorite). */
    prevFavState?: Record<string, boolean>;
    /** Song keys that should have audio in Drive (merged union + local picks). */
    audioRequests?: Set<string>;
    /** Audio upload policy for THIS device. */
    audioMode?: AudioMode;
    /** When the mode was chosen (for its LWW decision). */
    audioModeTs?: string;
  },
): Promise<DeviceSyncFile> {
  const db = DatabaseManager.getInstance();
  const tracks = await db.getAllTracks();
  const now = new Date().toISOString();

  // Keep whatever driveFileIds we already know (avoid re-uploading).
  const existingByKey = new Map<string, SyncTrackMeta>();
  for (const t of existingTracks ?? []) {
    if (t?.songKey) existingByKey.set(t.songKey, t);
  }

  const mode = opts?.audioMode ?? DEFAULT_AUDIO_MODE;
  // Requests come from the host already unioned with every device's merged
  // requests, so a request made on the PHONE causes this device (which owns the
  // file) to upload it.
  const requests = unionAudioRequests(opts?.audioRequests ?? []);
  const tombstoned = new Set((opts?.tombstones ?? []).map((t) => t.songKey));

  const syncTracks: SyncTrackMeta[] = [];
  for (const local of tracks) {
    const songKey = songKeyOf(local);
    if (tombstoned.has(songKey)) continue; // user explicitly deleted
    // Online/virtual tracks (bilibili://, youtube://) have no real local file to
    // upload and no playable offline copy — syncing their audio is impossible.
    // Their METADATA still syncs, so favorites/playlists stay consistent.
    const isOnline = local.isOnlineTrack?.() === true;

    const prior = existingByKey.get(songKey);
    let driveFileId = prior?.driveFileId;
    let justUploaded = false;
    let uploadedSize = 0;

    // ── Verify a remembered id before republishing it ──
    // A dead id must never be handed to another device (it would fail with
    // Google's "File not found"), and a dead id is not "already uploaded", so
    // the normal upload gate below can put a fresh copy back if it is wanted.
    let hadDeadId = false;
    if (driveFileId && token) {
      const resolved = await resolveAudioId(
        driveFileId,
        (id) => appDataFileExists(token, id),
        AUDIO_ID_CACHE,
      );
      if (!resolved) {
        driveFileId = undefined;
        hadDeadId = true;
      }
    }
    if (hadDeadId) {
      console.warn("[cloudsync] Drive audio for", songKey, "is gone — will re-upload if wanted");
    }

    const wantsAudio = wantsAudioInDrive(songKey, mode, requests);
    if (!isOnline && !driveFileId && wantsAudio && token) {
      try {
        const { bytes, mime } = await readAudio(local.filePath);
        const driveName = `audio__${hashString(songKey)}.bin`;
        driveFileId = await uploadAudioFile(token, driveName, bytes, mime);
        justUploaded = true;
        uploadedSize = bytes.length;
      } catch (e) {
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
      // Genuine "(re)added at" signal — beats a deletion tombstone only when the
      // song was added AFTER it was deleted.
      addedAt: local.dateAdded instanceof Date && !Number.isNaN(local.dateAdded.getTime())
        ? local.dateAdded.toISOString()
        : undefined,
      // Layer 2 — present only once some device uploaded the audio.
      driveFileId,
      audioSizeBytes: driveFileId
        ? (justUploaded ? uploadedSize : prior?.audioSizeBytes)
        : undefined,
      audioUploadedAt: driveFileId
        ? (justUploaded ? now : prior?.audioUploadedAt)
        : undefined,
      audioUploadedBy: driveFileId
        ? (justUploaded ? getDesktopDeviceId() : prior?.audioUploadedBy)
        : undefined,
    });
  }

  // Favorites as timestamped records — ONLY for songs this device has an entry
  // for (i.e. the user actually toggled it here). Untouched songs are omitted so
  // this device doesn't overwrite the favorite decided by the device that owns it.
  const favTs = opts?.favTs ?? {};
  const prevFavState = opts?.prevFavState ?? {};
  const favorites: FavRecord[] = [];
  for (const t of syncTracks) {
    const key = t.songKey;
    if (!favTs[key]) continue; // not touched here → leave to its owner device
    // If this device's favorite state CHANGED since its last push, stamp `now`
    // so the newest user intent (favorite OR un-favorite) wins LWW.
    const changed = prevFavState[key] !== undefined && prevFavState[key] !== t.isFavorite;
    const ts = changed ? now : favTs[key];
    if (changed) favTs[key] = now; // persist so the next push keeps this ts
    favorites.push({ songKey: key, fav: t.isFavorite, ts });
  }

  // Ratings / resume positions: only songs whose ts this device owns.
  const ratingTs = opts?.ratingTs ?? {};
  const ratings: RatingRecord[] = [];
  const positionTs = opts?.positionTs ?? {};
  const positions: PositionRecord[] = [];
  for (const local of tracks) {
    const key = songKeyOf(local);
    if (ratingTs[key]) {
      ratings.push({ songKey: key, stars: Track.clampRating(local.rating), ts: ratingTs[key] });
    }
    if (positionTs[key]) {
      positions.push({
        songKey: key,
        secs: Number(local.resumePositionSecs) || 0,
        ts: positionTs[key],
      });
    }
  }

  // This device's own listening counters (summed across devices on merge).
  const playStats: PlayStatRecord[] = [];
  try {
    const daily = await db.getDailyActivity(PLAY_STATS_DAYS);
    for (const [date, v] of daily) {
      playStats.push({ date, count: v.count, seconds: v.seconds });
    }
  } catch { /* no history yet */ }

  const playlistMeta = await db.getAllPlaylists();
  const playlistTs = opts?.playlistTs ?? {};
  const playlists: PlaylistRecord[] = [];
  for (const p of playlistMeta) {
    if (p.id === "__favorites__") continue; // captured as favorites above
    const ptracks = await db.getPlaylistTracks(p.id);
    const keys = ptracks.map((t) => songKeyOf(t)).sort();
    if (playlistTs[p.id]) {
      playlists.push({
        id: p.id,
        name: p.name,
        trackKeys: keys,
        ts: playlistTs[p.id],
      });
    }
  }

  return {
    deviceId: getDesktopDeviceId(),
    updatedAt: now,
    version: 3,
    tracks: syncTracks,
    tombstones: (opts?.tombstones ?? []).slice().sort((a, b) => a.songKey.localeCompare(b.songKey)),
    favorites,
    ratings,
    positions,
    playStats,
    audioRequests: [...requests].sort(),
    audioMode: mode,
    audioModeTs: opts?.audioModeTs ?? now,
    playlists,
  };
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
 * Apply a merged cross-device state into the desktop SQLite library.
 *
 * - Deletions: any locally-held track whose songKey is in the GLOBAL
 *   `deletedTracks` union is removed (strictly explicit — never diff-based).
 * - Favorites: set-style from the merged (LWW) favorites map (add + remove).
 * - Playlists: upsert each playlist and rebuild membership from the merged
 *   (LWW) playlist members.
 *
 * Returns what changed + the list of tracks removed (so the UI can delete
 * audio files) + the drive-synced tracks not yet present locally (so the UI
 * can auto-download + import them).
 */
export async function applyDesktopEnvelope(
  merged: MergedState,
): Promise<{
  changed: boolean;
  removed: { id: string; songKey: string; filePath: string; isOnline: boolean }[];
  newTracks: SyncTrackMeta[];
}> {
  const db = DatabaseManager.getInstance();
  let changed = false;
  const removed: { id: string; songKey: string; filePath: string; isOnline: boolean }[] = [];

  // 1) Explicit deletions: remove every local track whose songKey is in the
  //    global deletion union.
  const deletedKeys = new Set(merged.deletedTracks ?? []);
  if (deletedKeys.size > 0) {
    const tracks = await db.getAllTracks();
    for (const t of tracks) {
      const songKey = songKeyOf(t);
      if (deletedKeys.has(songKey)) {
        await db.removeTrack(t.id);
        removed.push({ id: t.id, songKey, filePath: t.filePath, isOnline: t.isOnlineTrack() });
        changed = true;
      }
    }
  }

  // 2) Which merged tracks (with audio) aren't present locally yet → import.
  const localKeys = new Set((await db.getAllTracks()).map((t) => songKeyOf(t)));
  const newTracks = (merged.tracks ?? []).filter(
    (t) => t.driveFileId && !deletedKeys.has(t.songKey) && !localKeys.has(t.songKey),
  );

  // 3) Favorites: set-style apply from the merged LWW map (add AND remove).
  const favMap = merged.favorites ?? new Map<string, boolean>();
  const tracks = await db.getAllTracks();
  for (const t of tracks) {
    const should = favMap.get(songKeyOf(t)) ?? false;
    if (should !== !!t.isFavorite) {
      await db.setFavorite(t.id, should);
      changed = true;
    }
  }

  // 3b) Ratings: apply the merged LWW value (0 clears the rating).
  const ratingMap = merged.ratings ?? new Map<string, number>();
  for (const t of tracks) {
    const want = Track.clampRating(ratingMap.get(songKeyOf(t)) ?? 0);
    if (want !== Track.clampRating(t.rating)) {
      await db.setRating(t.id, want);
      changed = true;
    }
  }

  // 3c) Resume positions: apply the merged LWW value.
  const posMap = merged.positions ?? new Map<string, number>();
  for (const t of tracks) {
    const want = Number(posMap.get(songKeyOf(t)) ?? 0) || 0;
    if (Math.abs(want - (Number(t.resumePositionSecs) || 0)) > 1) {
      await db.setResumePosition(t.id, want);
      changed = true;
    }
  }

  // 4) Playlists: upsert + rebuild membership (LWW merged members).
  for (const pl of merged.playlists ?? []) {
    const plTracks = await db.getAllTracks();
    const ids = resolveKeysToLocalIds(plTracks, pl.trackKeys ?? []);
    const all = await db.getAllPlaylists();
    if (!all.some((p) => p.id === pl.id)) {
      if (pl.id === "__favorites__") continue; // never create the special one
      await db.createPlaylist(pl.id, pl.name || pl.id);
    }
    if (pl.id !== "__favorites__") {
      await db.replacePlaylistTracks(pl.id, ids);
      changed = true;
    }
  }

  return { changed, removed, newTracks };
}

/**
 * Read the persisted favorite/playlist timestamps (the keys the user has
 * actually touched on THIS device). These are the ONLY keys this device will
 * claim "last-writer-wins" ownership of — untouched songs keep the state set by
 * whichever device last toggled them.
 */
export async function readDesktopTimestamps(): Promise<{
  favTs: Record<string, string>;
  playlistTs: Record<string, string>;
}> {
  // Desktop hook keeps favTs/playlistTs in localStorage; this reads them back.
  const g = globalThis as any;
  const read = (k: string): Record<string, string> => {
    try { return JSON.parse(g.localStorage.getItem(k) || "{}"); } catch { return {}; }
  };
  return {
    favTs: read("needmusic:gdrive:desktopFavTs"),
    playlistTs: read("needmusic:gdrive:desktopPlaylistTs"),
  };
}

/** Mark a songKey as "favorite touched on this device" with the given state. */
export async function touchDesktopFavorite(
  favTs: Record<string, string>,
  persist: (ts: Record<string, string>) => void,
  songKey: string,
  now: string,
): Promise<void> {
  favTs[songKey] = now;
  persist(favTs);
}

/** Mark a playlist id as "edited on this device". */
export async function touchDesktopPlaylist(
  playlistTs: Record<string, string>,
  persist: (ts: Record<string, string>) => void,
  id: string,
  now: string,
): Promise<void> {
  playlistTs[id] = now;
  persist(playlistTs);
}
