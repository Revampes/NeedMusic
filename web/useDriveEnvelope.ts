/**
 * useDriveEnvelope — helpers that build the Drive sync envelope (a
 * `DriveSyncEnvelope` blob) from the current web state (tracks + playlists),
 * and apply a resolved envelope back into the app — all using the shared
 * cross-device **song-key** contract.
 *
 * Kept separate from the sync hook so it can import TrackData / playlist
 * utilities without pulling the whole WebApp in.
 */

import type { TrackData } from "./bootstrap";
import {
  toSyncableState,
  applySyncedState,
  type ResolvedPlaylist,
  type SyncableState,
} from "./syncPayload";
import type { SyncTrackMeta } from "@core/services/cloudsync";
import type { DriveSyncEnvelope } from "./GoogleDriveSync";
import { loadPlaylists } from "./playlistsStore";
/** Stable per-browser device id (used to break ties / identify the writer). */
export function getDeviceId(): string {
  const K = "needmusic:gdrive:deviceId";
  try {
    let id = localStorage.getItem(K);
    if (!id) {
      id = `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(K, id);
    }
    return id;
  } catch {
    return `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Build the envelope describing the current local state. */
export function buildLocalEnvelope(tracks: TrackData[], cloudTracks?: SyncTrackMeta[]): DriveSyncEnvelope {
  return {
    lastUpdated: new Date().toISOString(),
    deviceId: getDeviceId(),
    payload: toSyncableState(tracks, loadPlaylists(), cloudTracks),
  };
}

/** A stable signature of the local payload — changes only when the data changes. */
export function payloadSignature(tracks: TrackData[]): string {
  return JSON.stringify(toSyncableState(tracks, loadPlaylists()));
}

interface ApplyCtx {
  /** Called with the set of favorite song keys to mark on local tracks. */
  setFavorites: (favoritesSongKeys: Set<string>) => void;
  /** Called with the reconciled local playlists (web track ids resolved). */
  setPlaylists: (playlists: ResolvedPlaylist[]) => void;
  /** Called with the synced drive track metadata (with driveFileId refs). */
  setDriveTracks: (driveTracks: SyncTrackMeta[]) => void;
}

/**
 * Apply a resolved (winning) envelope into the running app by resolving song keys
 * against the current local tracks: favorite song keys, reconciled playlists, and
 * the synced drive-track metadata (which the app can inject into its library and
 * use for Drive-based playback).
 */
export function applyDriveEnvelope(envelope: DriveSyncEnvelope, ctx: ApplyCtx, localTracks: TrackData[]): void {
  const state = (envelope.payload ?? {}) as SyncableState;
  const { favoritesSongKeys, playlists, driveTracks } = applySyncedState(state, localTracks);
  ctx.setFavorites(favoritesSongKeys);
  ctx.setPlaylists(playlists);
  ctx.setDriveTracks(driveTracks);
}
