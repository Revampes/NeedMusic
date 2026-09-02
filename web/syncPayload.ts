/**
 * syncPayload — maps NeedMusic web state (tracks + playlists) to the portable,
 * cross-device Drive payload and back, using the shared **song-key** contract.
 *
 * Only cross-device-meaningful data is synced:
 *   - favorites → a set of normalized song keys (`artist|title|album|duration`)
 *   - playlists (id, name, ordered song keys)
 *
 * Using song keys (rather than ids) is what lets the web build and the desktop
 * build reconcile the *same* song even though their track ids differ.
 * Device-specific fields (audioUrl, artworkUrl, LAN tokens) are never synced.
 */

import type { TrackData } from "./bootstrap";
import {
  songKeyOf,
  syncableFromTracks,
  favoritesFromTracks,
  type SyncableState,
  type SyncPlaylist,
  type SyncTrackMeta,
} from "@core/services/cloudsync";

export type { SyncableState, SyncPlaylist } from "@core/services/cloudsync";

/** Resolve a playlist's web track ids into cross-device song keys. */
function toTrackKeys(tracks: TrackData[], trackIds: string[]): string[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const id of trackIds) {
    const t = byId.get(id);
    if (!t) continue;
    const k = songKeyOf(t);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

/** Strip device-specific fields before upload; produce song-key playlists.
 *  `cloudTracks` (drive-synced metadata with driveFileIds) are preserved in the
 *  outgoing payload so web never clobbers another device's uploaded audio refs. */
export function toSyncableState(
  tracks: TrackData[],
  playlists: unknown[],
  cloudTracks?: SyncTrackMeta[],
  deletedTracks?: string[],
): SyncableState {
  const pl: { id: string; name: string; trackKeys: string[] }[] = (playlists as any[])
    .filter((p) => p && p.id && p.name)
    .map((p) => ({
      id: p.id,
      name: p.name,
      trackKeys: toTrackKeys(tracks, Array.isArray(p.trackIds) ? p.trackIds : []),
    }));
  const out = syncableFromTracks(tracks, pl) as SyncableState;
  if (cloudTracks && cloudTracks.length) {
    // Keep drive-synced audio refs only for songs that still exist locally.
    // A drive track the user deleted locally (absent from `tracks`) must NOT be
    // re-added to the outgoing payload — otherwise the deletion is undone and
    // the track is "revived" on every device.
    const localKeys = new Set(tracks.map((t) => songKeyOf(t)));
    const kept = cloudTracks.filter((t) => localKeys.has(t.songKey));
    if (kept.length) out.tracks = kept;
  }
  // Expose this device's explicit deletions so they propagate to Drive.
  if (deletedTracks && deletedTracks.length) out.deletedTracks = [...new Set(deletedTracks)].sort();
  return out;
}

/** Favorite song keys of the given tracks. */
export function favoritesOf(tracks: TrackData[]): string[] {
  return favoritesFromTracks(tracks as any);
}

export interface ResolvedPlaylist {
  id: string;
  name: string;
  trackIds: string[];
}

/**
 * Apply a synced payload back into web state:
 *  - returns the set of favorite song keys to mark on existing local tracks;
 *  - returns playlists whose `trackIds` were resolved back to local web track
 *    ids by matching song keys (so a synced playlist references real local rows).
 */
export function applySyncedState(
  state: SyncableState,
  localTracks: TrackData[],
): { favoritesSongKeys: Set<string>; playlists: ResolvedPlaylist[]; driveTracks: SyncTrackMeta[]; deletedTracks: string[] } {
  // Map song key → local track id (first match wins).
  const keyToIds = new Map<string, string[]>();
  for (const t of localTracks) {
    const k = songKeyOf(t);
    const arr = keyToIds.get(k);
    if (arr) arr.push(t.id); else keyToIds.set(k, [t.id]);
  }

  const playlists: ResolvedPlaylist[] = state.playlists.map((p) => {
    const trackIds: string[] = [];
    const seen = new Set<string>();
    for (const k of p.trackKeys || []) {
      const ids = keyToIds.get(k);
      if (!ids || !ids.length) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        trackIds.push(id);
        break; // one local track per song key in a playlist
      }
    }
    return { id: p.id, name: p.name, trackIds };
  });

  return {
    favoritesSongKeys: new Set(state.favorites ?? []),
    playlists,
    driveTracks: state.tracks ?? [],
    deletedTracks: state.deletedTracks ?? [],
  };
}
