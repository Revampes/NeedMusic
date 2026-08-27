/**
 * useWebDriveSync — the WebApp-facing wrapper around useGoogleSync.
 *
 * Owns the playlist change signal, builds `getLocalEnvelope` and
 * `payloadSignature` from the current tracks, and applies a resolved Drive
 * envelope back into the app (favorites + playlists) using the shared
 * cross-device song-key contract. Keeps WebApp.tsx small.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackData } from "./bootstrap";
import {
  useGoogleSync,
  type GoogleSyncStatus,
  type DriveAccount,
} from "./useGoogleSync";
import { buildLocalEnvelope, payloadSignature, applyDriveEnvelope } from "./useDriveEnvelope";
import { loadPlaylists, savePlaylists, type WebPlaylist } from "./playlistsStore";
import type { SyncTrackMeta } from "@core/services/cloudsync";
import type { DriveSyncEnvelope } from "./GoogleDriveSync";

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
}

interface Options {
  ready: boolean;
  tracks: TrackData[];
  /** Mark `isFavorite` on local tracks whose song key is in the given set. */
  onSetFavorites: (favoritesSongKeys: Set<string>) => void;
  /** Called after playlists were merged from the cloud. */
  onPlaylistsMerged?: (playlists: WebPlaylist[]) => void;
  /** Called with synced drive-track metadata (to inject into the library). */
  onDriveTracks?: (driveTracks: SyncTrackMeta[]) => void;
}

export function useWebDriveSync({
  ready,
  tracks,
  onSetFavorites,
  onPlaylistsMerged,
  onDriveTracks,
}: Options): WebDriveSync {
  // Bump when playlists change so the payload signature updates.
  const [playlistVersion, setPlaylistVersion] = useState(0);
  const onPlaylistsMergedRef = useRef(onPlaylistsMerged);
  onPlaylistsMergedRef.current = onPlaylistsMerged;
  const onDriveTracksRef = useRef(onDriveTracks);
  onDriveTracksRef.current = onDriveTracks;
  // Remember the last-synced drive tracks so web's own push doesn't clobber
  // another device's uploaded audio references.
  const knownDriveTracksRef = useRef<SyncTrackMeta[] | undefined>(undefined);

  useEffect(() => {
    const bump = () => setPlaylistVersion((v) => v + 1);
    window.addEventListener("needmusic:playlists-changed", bump);
    return () => window.removeEventListener("needmusic:playlists-changed", bump);
  }, []);

  /** Build the payload-signature for change detection. */
  const signature = useMemo(
    () => payloadSignature(tracks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, playlistVersion],
  );

  /** Build a fresh local envelope each time sync needs it (token unused by web). */
  const getLocalEnvelope = useCallback(
    (_token: string): DriveSyncEnvelope => buildLocalEnvelope(tracks, knownDriveTracksRef.current),
    [tracks],
  );

  /** Apply a resolved envelope to the running app. */
  const onApplyDrive = useCallback(
    (envelope: DriveSyncEnvelope) => {
      applyDriveEnvelope(
        envelope,
        {
          setFavorites: onSetFavorites,
          setPlaylists: (playlists) => {
            // Store the reconciled playlists locally (skip round-trip to cloud).
            savePlaylists(playlists as WebPlaylist[]);
            onPlaylistsMergedRef.current?.(playlists as WebPlaylist[]);
          },
          setDriveTracks: (dt) => {
            knownDriveTracksRef.current = dt;
            onDriveTracksRef.current?.(dt);
          },
        },
        tracks,
      );
    },
    [onSetFavorites, tracks],
  );

  const hook = useGoogleSync({
    ready,
    getLocalEnvelope,
    onApplyDrive,
    payloadSignature: signature,
  });

  return {
    status: hook.status,
    account: hook.account,
    signedIn: hook.signedIn,
    hasConfig: hook.hasConfig,
    token: hook.token,
    signIn: () => { void hook.signIn(); },
    signOut: hook.signOut,
    runSync: () => { void hook.runSync(); },
  };
}
