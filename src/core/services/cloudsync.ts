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
 *  `driveFileId` points to the file that holds this song's audio bytes.
 *
 *  Metadata is Layer 1 and ALWAYS syncs (even when no device has uploaded the
 *  audio yet); the `driveFileId`/`audio*` fields are Layer 2 and appear only
 *  once some device has uploaded the bytes. */
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
  /** Size of the uploaded audio, in bytes (for cache/quota reporting). */
  audioSizeBytes?: number;
  /** When the audio was uploaded (ISO) — newest upload wins on merge. */
  audioUploadedAt?: string;
  /** Which device uploaded the audio. */
  audioUploadedBy?: string;
  /**
   * When this device (re)added the song (ISO). Used to decide whether a track
   * should override a deletion tombstone: a song added *after* it was deleted
   * is a genuine re-import and survives.
   */
  addedAt?: string;
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
 * Deterministic per-device sync model (v3)
 *
 * Each device owns ONE file in the Drive appDataFolder (`sync-<deviceId>.json`)
 * and only ever writes to it, so there is NO concurrent-write race on a shared
 * file. Every sync cycle downloads all OTHER devices' files and merges them
 * with deterministic rules.
 *
 * v3 splits the payload into two independent layers:
 *
 *   LAYER 1 — metadata & state (tiny JSON, ALWAYS synced in full):
 *     tracks (metadata, with or without audio), favorites, ratings,
 *     resume positions, per-device play counters, playlists, tombstones.
 *
 *   LAYER 2 — audio bytes (heavy, USER-CONTROLLED):
 *     a track's `driveFileId` is present only once some device uploaded its
 *     audio (see `audioMode` / `audioRequests`). Metadata never depends on it.
 *
 * Deletion semantics use timestamped TOMBSTONES so a device that was offline
 * cannot resurrect a deleted song, and so old tombstones can be garbage
 * collected after `TOMBSTONE_TTL_DAYS`.
 *
 * Merge rules (deterministic — same inputs always give the same output):
 *   - tracks:        per songKey, metadata from the newest writer; an audio
 *                    reference (if any) is carried over.
 *   - tombstones:    per songKey, newest `deletedAt` wins.
 *   - resurrection:  a listed track beats a tombstone only if it was (re)added
 *                    after the deletion (`addedAt`) — legacy entries without
 *                    `addedAt` fall back to the v2 "owns audio" rule.
 *   - favorites/ratings/positions: last-writer-wins per songKey (timestamped).
 *   - playStats:     summed per date (each device's file holds only ITS OWN
 *                    counters, so summing can never double-count).
 *   - playlists:     last-writer-wins per playlist id.
 *   - audioMode:     last-writer-wins globally.
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

/** One explicit deletion, timestamped so it can propagate and later be GC'd. */
export interface Tombstone {
  songKey: string;
  deletedAt: string; // ISO-8601
  deviceId: string;
}

/** One rating record (1–5 stars; 0 = explicitly unrated). LWW per songKey. */
export interface RatingRecord {
  songKey: string;
  stars: number;
  ts: string; // ISO-8601
}

/** One resume-position record (seconds into the track). LWW per songKey. */
export interface PositionRecord {
  songKey: string;
  secs: number;
  ts: string; // ISO-8601
}

/**
 * Per-day listening counters. A device file holds ONLY its own counters, which
 * makes the merge a plain sum (no double counting, no clocks involved).
 */
export interface PlayStatRecord {
  date: string; // "YYYY-MM-DD"
  count: number; // plays
  seconds: number; // listened seconds
}

/** What a device uploads to Drive: everything, only marked tracks, or nothing. */
export type AudioMode = "all" | "selected" | "none";

export const DEFAULT_AUDIO_MODE: AudioMode = "selected";

/** Tombstones older than this are garbage collected (and their audio reclaimed). */
export const TOMBSTONE_TTL_DAYS = 30;

/** Content of one device's own sync file. */
export interface DeviceSyncFile {
  deviceId: string;
  /** When this device last pushed its file. */
  updatedAt: string;
  /** Payload format version. Absent means a legacy (v2) file. */
  version?: number;
  /** Every track this device knows, WITH or WITHOUT audio (Layer 1). */
  tracks: SyncTrackMeta[];
  /** v3: timestamped explicit deletions. */
  tombstones?: Tombstone[];
  /** v2 legacy field — read for back-compat, never written by v3. */
  deletedTracks?: string[];
  /** Favorite records (per-songKey timestamped). */
  favorites: FavRecord[];
  /** v3: ratings (LWW). */
  ratings?: RatingRecord[];
  /** v3: resume positions (LWW). */
  positions?: PositionRecord[];
  /** v3: this device's own per-day play counters (summed on merge). */
  playStats?: PlayStatRecord[];
  /** v3: song keys this device wants available in Drive (union). */
  audioRequests?: string[];
  /** v3: global upload policy (LWW). */
  audioMode?: AudioMode;
  /** v3: when `audioMode` was set (for its LWW decision). */
  audioModeTs?: string;
  /** Playlist records (per-id timestamped). */
  playlists: PlaylistRecord[];
}

/** The deterministic result of merging all devices' files. */
export interface MergedState {
  /** Authoritative track list (union, deletions excluded). */
  tracks: SyncTrackMeta[];
  /** Effective deletions (not resurrected, not yet GC'd) — suppress resurrects. */
  deletedTracks: string[];
  /** Tombstones still in effect (drives GC of orphaned Drive audio). */
  tombstones: Tombstone[];
  /** songKey → favorited (LWW by ts). */
  favorites: Map<string, boolean>;
  /** songKey → stars 0-5 (LWW by ts). */
  ratings: Map<string, number>;
  /** songKey → resume position in seconds (LWW by ts). */
  positions: Map<string, number>;
  /** date → summed plays/seconds across every device. */
  playStats: Map<string, { count: number; seconds: number }>;
  /** Union of every device's audio requests (Layer 2). */
  audioRequests: string[];
  /** Global upload policy (LWW). */
  audioMode: AudioMode;
  /** Playlists resolved by LWW per id. */
  playlists: PlaylistRecord[];
}

function tsOf(s?: string): number {
  if (!s) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** Read a file's tombstones, translating the v2 `deletedTracks` list if present. */
function tombstonesOf(f: DeviceSyncFile): Tombstone[] {
  const out: Tombstone[] = [];
  for (const t of f?.tombstones ?? []) {
    if (t?.songKey && t.deletedAt) out.push(t);
  }
  // Legacy v2: a bare songKey list with no timestamps. The file's `updatedAt`
  // is the best available "when" — it is when that device pushed the deletion.
  const legacyAt = f?.updatedAt || new Date(0).toISOString();
  for (const k of f?.deletedTracks ?? []) {
    if (k) out.push({ songKey: k, deletedAt: legacyAt, deviceId: f.deviceId || "unknown" });
  }
  return out;
}

/**
 * Merge an arbitrary set of device files into one authoritative state.
 * Deterministic: given the same files, the result is always identical.
 *
 * `now` is injectable so the tombstone GC boundary is testable.
 */
export function mergeDeviceFiles(
  files: DeviceSyncFile[],
  now: number = Date.now(),
): MergedState {
  // 0) Each device owns exactly ONE file, but be defensive: if a caller passes
  //    the same device twice (e.g. a stale copy alongside a fresh one), keep
  //    only the newest — otherwise that device's per-day play counters would be
  //    summed twice.
  const byDevice = new Map<string, DeviceSyncFile>();
  let anon = 0;
  for (const f of files ?? []) {
    if (!f) continue;
    const id = f.deviceId || `anon-${anon++}`;
    const cur = byDevice.get(id);
    if (!cur || tsOf(f.updatedAt) > tsOf(cur.updatedAt)) byDevice.set(id, f);
  }
  const list = [...byDevice.values()];

  // 1) Tombstones: newest `deletedAt` wins per songKey (deviceId breaks ties so
  //    the result stays deterministic for identical timestamps).
  const tombByKey = new Map<string, Tombstone>();
  for (const f of list) {
    for (const t of tombstonesOf(f)) {
      const cur = tombByKey.get(t.songKey);
      if (
        !cur ||
        tsOf(t.deletedAt) > tsOf(cur.deletedAt) ||
        (tsOf(t.deletedAt) === tsOf(cur.deletedAt) && t.deviceId > cur.deviceId)
      ) {
        tombByKey.set(t.songKey, t);
      }
    }
  }

  // 2) Tracks: newest writer wins the metadata; any audio reference is carried
  //    along so a later metadata write never drops another device's upload.
  interface Acc {
    meta: SyncTrackMeta;
    writerTs: number;
    addedAt: number;
    /** Best-known audio reference for this song (uploads are device-agnostic). */
    driveFileId?: string;
    audioSizeBytes?: number;
    audioUploadedAt?: string;
    audioUploadedBy?: string;
  }
  const acc = new Map<string, Acc>();
  for (const f of list) {
    const writerTs = tsOf(f.updatedAt);
    for (const t of f.tracks ?? []) {
      if (!t?.songKey) continue;
      const addedAt = tsOf(t.addedAt);
      const cur = acc.get(t.songKey);
      // Prefer the entry with audio as the audio source (newest upload wins).
      const betterAudio =
        !!t.driveFileId &&
        (!cur?.driveFileId || tsOf(t.audioUploadedAt) > tsOf(cur.audioUploadedAt));
      if (!cur || writerTs > cur.writerTs) {
        acc.set(t.songKey, {
          meta: cur && writerTs <= cur.writerTs ? cur.meta : t,
          writerTs: cur && writerTs <= cur.writerTs ? cur.writerTs : writerTs,
          addedAt: cur ? Math.max(cur.addedAt, addedAt) : addedAt,
          driveFileId: betterAudio ? t.driveFileId : cur?.driveFileId,
          audioSizeBytes: betterAudio ? t.audioSizeBytes : cur?.audioSizeBytes,
          audioUploadedAt: betterAudio ? t.audioUploadedAt : cur?.audioUploadedAt,
          audioUploadedBy: betterAudio ? t.audioUploadedBy : cur?.audioUploadedBy,
        });
      } else {
        if (betterAudio) {
          cur.driveFileId = t.driveFileId;
          cur.audioSizeBytes = t.audioSizeBytes;
          cur.audioUploadedAt = t.audioUploadedAt;
          cur.audioUploadedBy = t.audioUploadedBy;
        }
        cur.addedAt = Math.max(cur.addedAt, addedAt);
      }
    }
  }

  // 3) Apply deletions. A song survives a tombstone only if it was (re)added
  //    after the deletion. Legacy entries carry no `addedAt`, so fall back to
  //    the v2 rule: owning real audio counts as ownership.
  const tracks: SyncTrackMeta[] = [];
  const resurrected = new Set<string>();
  for (const [songKey, a] of acc) {
    const tomb = tombByKey.get(songKey);
    if (tomb) {
      const deletedAt = tsOf(tomb.deletedAt);
      const revived = Number.isFinite(a.addedAt)
        ? a.addedAt > deletedAt
        : !!a.driveFileId; // legacy v2 fallback
      if (!revived) continue;
      resurrected.add(songKey);
    }
    tracks.push({
      ...a.meta,
      driveFileId: a.driveFileId ?? a.meta.driveFileId,
      audioSizeBytes: a.audioSizeBytes,
      audioUploadedAt: a.audioUploadedAt,
      audioUploadedBy: a.audioUploadedBy,
    });
  }
  tracks.sort((x, y) => x.songKey.localeCompare(y.songKey));

  // 4) Every tombstoned song that was NOT resurrected counts as deleted — even
  //    when no device still lists it, which is the normal case right after the
  //    deleting device dropped it from its own library. That is exactly the set
  //    local devices must remove. Tombstones past their TTL are then collected
  //    (the user accepted that a device offline for longer than the window can
  //    resurrect a song).
  const ttlMs = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const deletedKeys: string[] = [];
  const keptTombstones: Tombstone[] = [];
  for (const [songKey, t] of tombByKey) {
    if (resurrected.has(songKey)) continue; // re-added → not deleted
    if (now - tsOf(t.deletedAt) > ttlMs) continue; // past its TTL → forget it
    deletedKeys.push(songKey);
    keptTombstones.push(t);
  }
  deletedKeys.sort();
  keptTombstones.sort((a, b) => a.songKey.localeCompare(b.songKey));

  // 5) Favorites: per-songKey LWW.
  const favMap = new Map<string, FavRecord>();
  for (const f of list) {
    for (const fr of f?.favorites ?? []) {
      if (!fr?.songKey) continue;
      const cur = favMap.get(fr.songKey);
      if (!cur || tsOf(fr.ts) > tsOf(cur.ts)) favMap.set(fr.songKey, fr);
    }
  }

  // 6) Ratings: per-songKey LWW.
  const ratingMap = new Map<string, RatingRecord>();
  for (const f of list) {
    for (const r of f?.ratings ?? []) {
      if (!r?.songKey) continue;
      const cur = ratingMap.get(r.songKey);
      if (!cur || tsOf(r.ts) > tsOf(cur.ts)) ratingMap.set(r.songKey, r);
    }
  }

  // 7) Resume positions: per-songKey LWW.
  const posMap = new Map<string, PositionRecord>();
  for (const f of list) {
    for (const p of f?.positions ?? []) {
      if (!p?.songKey) continue;
      const cur = posMap.get(p.songKey);
      if (!cur || tsOf(p.ts) > tsOf(cur.ts)) posMap.set(p.songKey, p);
    }
  }

  // 8) Play counters: sum per date (each device contributes only its own).
  const stats = new Map<string, { count: number; seconds: number }>();
  for (const f of list) {
    for (const s of f?.playStats ?? []) {
      if (!s?.date) continue;
      const cur = stats.get(s.date) ?? { count: 0, seconds: 0 };
      cur.count += Number(s.count) || 0;
      cur.seconds += Number(s.seconds) || 0;
      stats.set(s.date, cur);
    }
  }

  // 9) Audio requests: union.
  const requests = new Set<string>();
  for (const f of list) {
    for (const k of f?.audioRequests ?? []) if (k) requests.add(k);
  }

  // 10) Audio mode: LWW globally (tie-break on deviceId for determinism).
  let audioMode: AudioMode = DEFAULT_AUDIO_MODE;
  let modeTs = Number.NEGATIVE_INFINITY;
  let modeDevice = "";
  for (const f of list) {
    if (!f?.audioMode) continue;
    const ts = tsOf(f.audioModeTs ?? f.updatedAt);
    if (ts > modeTs || (ts === modeTs && (f.deviceId || "") > modeDevice)) {
      audioMode = f.audioMode;
      modeTs = ts;
      modeDevice = f.deviceId || "";
    }
  }

  // 11) Playlists: per-id LWW.
  const plMap = new Map<string, PlaylistRecord>();
  for (const f of list) {
    for (const p of f?.playlists ?? []) {
      if (!p?.id) continue;
      const cur = plMap.get(p.id);
      if (!cur || tsOf(p.ts) > tsOf(cur.ts)) plMap.set(p.id, p);
    }
  }

  return {
    tracks,
    deletedTracks: deletedKeys,
    tombstones: keptTombstones,
    favorites: new Map([...favMap.entries()].map(([k, v]) => [k, v.fav])),
    ratings: new Map([...ratingMap.entries()].map(([k, v]) => [k, v.stars])),
    positions: new Map([...posMap.entries()].map(([k, v]) => [k, v.secs])),
    playStats: stats,
    audioRequests: [...requests].sort(),
    audioMode,
    playlists: [...plMap.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
  };
}

/** True when a tombstone is older than the GC window (drives Drive audio cleanup). */
export function isTombstoneExpired(t: Tombstone, now: number = Date.now()): boolean {
  return now - tsOf(t.deletedAt) > TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/* ─── Layer-2 (audio) decisions ───────────────────────────────────────────────
 * One source of truth for "should this song's AUDIO exist in Drive / be kept on
 * this device". Both builds previously duplicated this rule, and getting it
 * wrong is invisible until a user cannot download their own music.
 * ────────────────────────────────────────────────────────────────────────── */

/** Union of this device's own offline marks and every device's merged requests. */
export function unionAudioRequests(...sets: Iterable<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) {
    for (const k of s) if (k) out.add(k);
  }
  return out;
}

/**
 * Should `songKey`'s audio be held in Drive (uploaded / downloaded)?
 *
 * - `all`      → yes, for every song (full cloud backup).
 * - `none`     → never.
 * - `selected` → only when SOME device asked for it. Every supplied request set
 *   is checked, because the device that owns the file must honour a request made
 *   on another device (e.g. the phone asking for a song only the computer has).
 *   Consulting only the *local* set here is the bug that made on-demand
 *   downloads impossible.
 */
export function wantsAudioInDrive(
  songKey: string,
  mode: AudioMode,
  ...requestSets: Iterable<string>[]
): boolean {
  if (!songKey) return false;
  if (mode === "all") return true;
  if (mode === "none") return false;
  for (const set of requestSets) {
    for (const k of set) if (k === songKey) return true;
  }
  return false;
}

/** Session caches for Drive audio-id verification (see `resolveAudioId`). */
export interface AudioIdCache {
  /** Ids confirmed to exist this run — trusted without another request. */
  verified: Set<string>;
  /** Ids confirmed gone — never republished, never re-checked this run. */
  dead: Set<string>;
}

/**
 * Reconcile a library row's audio pointer with the merged (cloud) metadata.
 *
 * Returns the pointer to store, or `null` when it should be left alone.
 *
 * - A row backed by a LAN / blob / data source is never rewritten — a local
 *   source is preferable to streaming from Drive.
 * - A Drive-backed row (or one with no source yet) follows the cloud: it gains
 *   the audio when it appears, adopts a NEW id when the old one was replaced
 *   (e.g. after the owner re-uploaded), and loses the pointer when the cloud no
 *   longer has the audio — so playback can never keep using a dead id and fail
 *   with Google's "File not found".
 */
export function reconcileAudioUrl(
  currentAudioUrl: string | undefined,
  driveFileId: string | undefined,
): string | null {
  const current = currentAudioUrl ?? "";
  const driveOwned = current === "" || current.startsWith("drive://");
  if (!driveOwned) return null; // LAN / blob / data → leave it alone
  const want = driveFileId ? `drive://${driveFileId}` : "";
  return current === want ? null : want;
}

/**
 * Decide whether a remembered Drive audio id can still be trusted.
 *
 * Returns the id to publish, or `undefined` when it is gone (so another device
 * never receives an id that would fail with Google's "File not found").
 *
 * - already verified → trust it (no request)
 * - already known dead → forget it (no request)
 * - otherwise ask `verify`, and cache the answer either way
 * - if `verify` throws (network/auth hiccup) the id is TRUSTED, because a
 *   transient failure must never trigger a library-wide re-upload
 */
export async function resolveAudioId(
  driveFileId: string | undefined,
  verify: (id: string) => Promise<boolean>,
  cache: AudioIdCache,
): Promise<string | undefined> {
  if (!driveFileId) return undefined;
  if (cache.verified.has(driveFileId)) return driveFileId;
  if (cache.dead.has(driveFileId)) return undefined;
  let alive: boolean;
  try {
    alive = await verify(driveFileId);
  } catch {
    return driveFileId; // transient error — keep trusting it
  }
  if (alive) {
    cache.verified.add(driveFileId);
    return driveFileId;
  }
  cache.dead.add(driveFileId);
  return undefined;
}

