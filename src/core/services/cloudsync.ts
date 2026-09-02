/**
 * cloudsync — the shared cross-device sync contract used by BOTH the desktop
 * (Tauri) app and the web app.
 *
 * Why a shared contract: the desktop and web builds each have their own track
 * id scheme (`track_<hash(filePath)>` vs LAN-provided ids), so they can't merge
 * a song by its id. Instead every synced song is keyed by a **normalized song
 * key** — `artist | title | album | durationSecs` — which both sides can derive
 * for any track. Favorites and playlists then reference song keys, letting the
 * two sides reconcile the "same" song even when their ids differ.
 *
 * Data contract stored in Google Drive's appDataFolder (app_data.json):
 *   {
 *     lastUpdated: string,        // ISO-8601 — used by resolveConflicts
 *     deviceId:   string,         // tie-breaker
 *     payload: SyncableState
 *   }
 */

/** A stable, case/space-normalized song fingerprint for cross-device matching. */
export function makeSongKey(
  title: string,
  artist: string,
  album: string,
  durationSecs: number,
): string {
  const norm = (s: string) =>
    (s || "")
      .toLowerCase()
      .replace(/[\s\-_.'’/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return [
    norm(artist) || "unknown-artist",
    norm(title) || "unknown-title",
    norm(album) || "unknown-album",
    durationSecs ? Math.round(durationSecs) : "?",
  ].join("|");
}

/**
 * A track-shaped object that is enough to build a song key. Both the desktop
 * `Track` and the web `TrackData` satisfy this structurally (they share
 * title/artist/album/durationSecs).
 */
export interface SongKeyProvider {
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
}

/** Build the song key from any track-like object. */
export function songKeyOf(t: SongKeyProvider): string {
  return makeSongKey(t.title, t.artist, t.album, t.durationSecs);
}

/** One playlist entry: id + name + ordered list of cross-device song keys. */
export interface SyncPlaylist {
  id: string;
  name: string;
  trackKeys: string[];
}

/** Portable track metadata + reference to its audio in the Drive appDataFolder.
 *  `driveFileId` points to the file that holds this song's audio bytes. */
export interface SyncTrackMeta {
  songKey: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  durationSecs: number;
  genre?: string;
  year?: number | null;
  codec?: string;
  isFavorite: boolean;
  /** Drive appDataFolder file id containing the audio for this song. */
  driveFileId?: string;
}

/** The portable payload stored in the Drive envelope. */
export interface SyncableState {
  /** Song keys of favorites (cross-device). */
  favorites: string[];
  /** Custom playlists (excluding the implicit Favorites list). */
  playlists: SyncPlaylist[];
  /** Track metadata + audio references (uploaded audio files). */
  tracks?: SyncTrackMeta[];
  /** Song keys of tracks EXPLICITLY deleted on some device — propagated so every
   *  device deletes them too. Never inferred by diff. */
  deletedTracks?: string[];
}

/** Build a SyncableState from an array of track-like objects (any provider). */
export function syncableFromTracks(
  tracks: SongKeyProvider[],
  playlists: { id: string; name: string; trackKeys: string[] }[],
): SyncableState {
  return {
    favorites: favoritesFromTracks(tracks),
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, trackKeys: p.trackKeys })),
  };
}

/**
 * Reconcile tracks between local (a) and drive (b), SAFELY:
 * - Start from drive (b), which stays authoritative.
 * - Add local entries (a) that aren't in drive AND aren't in the
 *   `previouslySynced` set (genuinely-new uploads this session).
 * - Remove any key in `pendingDeletes` — these are tracks the user EXPLICITLY
 *   deleted on this device, so the deletion propagates to Drive and other
 *   devices. This is an explicit-intent list, NOT a diff: a track merely being
 *   absent from a device's local list never causes deletion.
 * Deterministic order (sorted by songKey) keeps signatures stable.
 */
export function mergeTrackLists(
  a: SyncTrackMeta[],
  b: SyncTrackMeta[],
  previouslySynced: Set<string> = new Set(),
  pendingDeletes: Set<string> = new Set(),
): SyncTrackMeta[] {
  const byKey = new Map<string, SyncTrackMeta>();
  for (const t of b) {
    if (!t.songKey || pendingDeletes.has(t.songKey)) continue;
    byKey.set(t.songKey, t);
  }
  for (const t of a) {
    if (!t.songKey || pendingDeletes.has(t.songKey)) continue;
    if (byKey.has(t.songKey)) continue; // already in drive / result
    if (previouslySynced.has(t.songKey)) continue; // previously synced, not new here
    if (pendingDeletes.has(t.songKey)) continue;
    byKey.set(t.songKey, t);
  }
  return [...byKey.values()].sort((x, y) => x.songKey.localeCompare(y.songKey));
}

/** Union of explicitly-deleted song keys (deduped, sorted for stable signatures). */
export function mergeDeletedKeys(a: string[] = [], b: string[] = []): string[] {
  const s = new Set([...a, ...b]);
  return [...s].sort();
}
export function favoritesFromTracks(tracks: (SongKeyProvider & { isFavorite?: boolean })[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tracks) {
    if (!t.isFavorite) continue;
    const k = songKeyOf(t);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Apply cloud data back into a local track list:
 *  - mark `isFavorite` on any local track whose song key is in `cloud.favorites`;
 *  - return playlists reconciled alongside the local lists.
 *
 * (Removing a favorite is intentionally NOT destructive to keep two devices
 * from fighting over a heart; favorites are a monotonically-merged best-effort.)
 */
export function applyCloudToTracks(
  tracks: (SongKeyProvider & { isFavorite?: boolean })[],
  cloud: { favorites?: string[]; playlists?: SyncPlaylist[] },
): { trackCount: number; favoritesSongKeys: Set<string>; playlists: SyncPlaylist[] } {
  const fav = new Set(cloud.favorites ?? []);
  if (fav.size > 0) {
    for (const t of tracks) {
      if (fav.has(songKeyOf(t))) t.isFavorite = true;
    }
  }
  return {
    trackCount: tracks.length,
    favoritesSongKeys: fav,
    playlists: cloud.playlists ?? [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic per-device sync model (v2)
 *
 * Each device owns ONE file in the Drive appDataFolder (`sync-<deviceId>.json`)
 * and only ever writes to it, so there is NO concurrent-write race on a shared
 * file. Every sync cycle downloads all OTHER devices' files and merges them
 * with deterministic rules:
 *
 *   - tracks:       union of all devices' tracks, strictly excluding any songKey
 *                   present in the GLOBAL deletedTracks union (deletion wins and
 *                   never resurrects — the user's #1 requirement).
 *   - favorites:    last-writer-wins per songKey (timestamped records), so
 *                   un-favoriting propagates like favoriting does.
 *   - playlists:    last-writer-wins per playlist id (timestamped records), so
 *                   adding/removing tracks in a playlist propagates too.
 *
 * This replaces the old "single app_data.json + whole-blob lastUpdated wins +
 * Changes API" design, which was unreliable (random track counts, flaky sync).
 * ──────────────────────────────────────────────────────────────────────────── */

/** One favorite record: the favorited state of one song at a point in time. */
export interface FavRecord {
  songKey: string;
  fav: boolean;
  ts: string; // ISO-8601
}

/** One playlist record with its last-edit timestamp. */
export interface PlaylistRecord {
  id: string;
  name: string;
  trackKeys: string[];
  ts: string; // ISO-8601
}

/** Content of one device's own sync file. */
export interface DeviceSyncFile {
  deviceId: string;
  /** When this device last pushed its file. */
  updatedAt: string;
  /** Tracks this device currently owns (with audio refs). */
  tracks: SyncTrackMeta[];
  /** Song keys this device has EXPLICITLY deleted (persisted, additive). */
  deletedTracks: string[];
  /** Favorite records (per-songKey timestamped). */
  favorites: FavRecord[];
  /** Playlist records (per-id timestamped). */
  playlists: PlaylistRecord[];
}

/** The deterministic result of merging all devices' files. */
export interface MergedState {
  /** Authoritative track list (union, deletions excluded). */
  tracks: SyncTrackMeta[];
  /** Global union of every device's explicit deletions. */
  deletedTracks: string[];
  /** songKey → favorited (LWW by ts). */
  favorites: Map<string, boolean>;
  /** Playlists resolved by LWW per id. */
  playlists: PlaylistRecord[];
}

function tsOf(s?: string): number {
  if (!s) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Merge an arbitrary set of device files into one authoritative state.
 * Deterministic: given the same files, the result is always identical.
 *
 * Deletion semantics ("delete then re-import the same song"):
 * - A songKey in `deletedTracks` is removed from the synced library **unless**
 *   some device currently owns it again with real, usable audio (a non-empty
 *   `driveFileId`). Owning it again (e.g. re-importing the same track after a
 *   delete) "resurrects" it, so deleting + re-adding the same song works.
 * - Songs with audio (driveFileId) that no device owns are still deleted.
 */
export function mergeDeviceFiles(files: DeviceSyncFile[]): MergedState {
  // 1) Collected deletions.
  const globalDeleted = new Set<string>();
  for (const f of files) {
    for (const k of f?.deletedTracks ?? []) if (k) globalDeleted.add(k);
  }

  // Which songKeys are currently owned WITH real audio on some device?
  const ownedWithAudio = new Set<string>();
  for (const f of files) {
    for (const t of f?.tracks ?? []) {
      if (t?.songKey && t.driveFileId) ownedWithAudio.add(t.songKey);
    }
  }

  // 2) Tracks: union, newest device metadata wins. A songKey that is both
  //    deleted AND still owned-with-audio on some device is "resurrected".
  const tracksByKey = new Map<string, { meta: SyncTrackMeta; ts: number }>();
  for (const f of files) {
    const ts = tsOf(f?.updatedAt);
    for (const t of f?.tracks ?? []) {
      if (!t?.songKey) continue;
      const resurrected = ownedWithAudio.has(t.songKey);
      if (globalDeleted.has(t.songKey) && !resurrected) continue;
      const cur = tracksByKey.get(t.songKey);
      if (!cur || ts > cur.ts) tracksByKey.set(t.songKey, { meta: t, ts });
    }
  }

  // 3) Deletions still effective = those NOT resurrected by an owned copy.
  const effectiveDeleted = new Set<string>();
  for (const k of globalDeleted) {
    if (!ownedWithAudio.has(k)) effectiveDeleted.add(k);
  }

  // 4) Favorites: per-songKey LWW.
  const favMap = new Map<string, FavRecord>();
  for (const f of files) {
    for (const fr of f?.favorites ?? []) {
      if (!fr?.songKey) continue;
      const cur = favMap.get(fr.songKey);
      if (!cur || tsOf(fr.ts) > tsOf(cur.ts)) favMap.set(fr.songKey, fr);
    }
  }

  // 5) Playlists: per-id LWW.
  const plMap = new Map<string, PlaylistRecord>();
  for (const f of files) {
    for (const p of f?.playlists ?? []) {
      if (!p?.id) continue;
      const cur = plMap.get(p.id);
      if (!cur || tsOf(p.ts) > tsOf(cur.ts)) plMap.set(p.id, p);
    }
  }

  return {
    tracks: [...tracksByKey.values()]
      .map((x) => x.meta)
      .sort((a, b) => a.songKey.localeCompare(b.songKey)),
    deletedTracks: [...effectiveDeleted].sort(),
    favorites: new Map([...favMap.entries()].map(([k, v]) => [k, v.fav])),
    playlists: [...plMap.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
  };
}
