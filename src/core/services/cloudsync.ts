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
 * Union two track-metadata lists by song key, preferring the entry that has a
 * driveFileId (its audio is actually uploaded). Used so one device's uploaded
 * audio references are never clobbered by another device's empty/web payload.
 * Deterministic order (sorted by songKey) keeps signatures stable.
 */
export function mergeTrackLists(a: SyncTrackMeta[], b: SyncTrackMeta[]): SyncTrackMeta[] {
  const byKey = new Map<string, SyncTrackMeta>();
  for (const t of a) if (t.songKey) byKey.set(t.songKey, t);
  for (const t of b) {
    if (!t.songKey) continue;
    const prev = byKey.get(t.songKey);
    // Prefer whichever actually has a Drive audio reference (fall back to `t`).
    if (!prev || !prev.driveFileId) byKey.set(t.songKey, t);
  }
  return [...byKey.values()].sort((x, y) => x.songKey.localeCompare(y.songKey));
}

/** Favorites = song keys of tracks flagged favorite. */
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
