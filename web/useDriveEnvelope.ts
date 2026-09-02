/**
 * useDriveEnvelope — small web helpers (device id + a local-payload signature)
 * used by the Drive sync hook, based on the shared cross-device song-key
 * contract.
 */

import type { TrackData } from "./bootstrap";
import { toSyncableState } from "./syncPayload";
import { loadPlaylists } from "./playlistsStore";
/** Stable per-browser device id (identifies this device in the sync model). */
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

/** A stable signature of the local payload — changes only when the data changes. */
export function payloadSignature(tracks: TrackData[]): string {
  return JSON.stringify(toSyncableState(tracks, loadPlaylists()));
}

