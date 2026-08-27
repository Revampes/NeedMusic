/**
 * useDesktopDriveSync — the desktop (Tauri) wrapper around the shared
 * `useGoogleSync` hook. Owns the payload-signature signal and bridges the
 * SQLite library (via `cloudsyncDb`) to the Drive realm.
 *
 * Note on the sign-in origin: in development the Tauri window loads from
 * `http://localhost:1420` (see vite.config.ts / tauri.conf.json devUrl), so
 * that origin must be registered as an Authorized JavaScript origin. In
 * production the window uses `http://tauri.localhost` which must also be
 * registered. See docs/google-drive-sync.md.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setGoogleClientId, SYNC_SCOPE } from "@core/services/googleDriveSync";
import type { Track } from "@core/models/Track";
import {
  useGoogleSync,
  type GoogleSyncStatus,
  type DriveAccount,
} from "./useGoogleSync";
import {
  buildDesktopEnvelope,
  applyDesktopEnvelope,
} from "@core/services/cloudsyncDb";
import { songKeyOf, type SyncTrackMeta } from "@core/services/cloudsync";
import type { DriveSyncEnvelope } from "@core/services/googleDriveSync";

/** Configure the desktop build's client id (called once at startup). */
export function configureDesktopGoogleClientId(clientId: string): void {
  setGoogleClientId(clientId);
}

export interface DesktopDriveSync {
  status: GoogleSyncStatus;
  account: DriveAccount | null;
  signedIn: boolean;
  hasConfig: boolean;
  signIn: () => void;
  signOut: () => void;
  runSync: () => void;
}

interface Options {
  ready: boolean;
  tracks: Track[];
  /** Bump whenever playlists/favorites change so a Drive push is triggered. */
  changeVersion?: number;
  /** Called after cloud data was applied so the UI can refresh the library. */
  onSyncedApplied?: () => void | Promise<void>;
  /** Current CLIENT_ID for the OAuth screen (may be empty → needs-config). */
  clientId?: string;
  /** OAuth client secret (desktop only). Google insists on it at the token
   *  endpoint for this client even with PKCE. */
  clientSecret?: string;
}

export function useDesktopDriveSync({
  ready,
  tracks,
  changeVersion = 0,
  onSyncedApplied,
  clientId = "",
  clientSecret = "",
}: Options): DesktopDriveSync {
  // Make sure the shared layer knows the client id for this session (idempotent).
  useEffect(() => {
    if (clientId.trim()) setGoogleClientId(clientId.trim());
  }, [clientId]);

  /** Reflect data changes in a synchronously computed signature. */
  const signature = useMemo(
    () =>
      `${changeVersion}|${tracks.map((t) => songKeyOf(t)).join("|")}|${tracks
        .map((t) => (t.isFavorite ? "1" : "0"))
        .join("")}`,
    [tracks, changeVersion],
  );

  /** Build a fresh envelope from the SQLite library (async). */
  // Cache the last-known `tracks` (with driveFileIds) so we don't re-upload
  // audio that already has a Drive copy on the very next sync.
  const knownTracksRef = useRef<SyncTrackMeta[] | undefined>(undefined);

  const readAudio = useCallback(async (path: string): Promise<{ bytes: Uint8Array; mime: string }> => {
    const dataUrl: string = await invoke("read_audio_file", { filePath: path });
    const idx = dataUrl.indexOf(";base64,");
    const mime = idx >= 0 ? dataUrl.slice(5, idx) : "audio/mpeg";
    const b64 = idx >= 0 ? dataUrl.slice(idx + 8) : "";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  }, []);

  const getLocalEnvelope = useCallback(
    async (token: string): Promise<DriveSyncEnvelope> => {
      const env = await buildDesktopEnvelope(token, readAudio, knownTracksRef.current);
      // Remember the driveFileIds we just produced so the next build skips them.
      knownTracksRef.current = (env.payload as any)?.tracks as SyncTrackMeta[] | undefined;
      return env;
    },
    [readAudio],
  );

  /** Apply a resolved envelope into SQLite, then ask the app to refresh. */
  const onApplyDrive = useCallback(
    async (envelope: DriveSyncEnvelope) => {
      let changed = false;
      try {
        changed = await applyDesktopEnvelope(envelope);
      } catch { /* logged by caller */ }
      if (changed) await onSyncedApplied?.();
    },
    [onSyncedApplied],
  );

  /**
   * System-browser OAuth (PKCE) via the Rust backend — used because the desktop
   * app's origin can't be an Authorized JS origin for Google's inline GIS flow.
   * Opens the OS browser, polls the loopback callback for the code, and returns
   * the exchanged access token (or "" on timeout/cancel).
   *
   * The desktop uses a full OIDC authorization-code flow (`openid email profile`
   * + `drive.appdata`). Google's "/o/oauth2/v2/auth" treats a Web-app client with
   * `response_type=code` + `openid` as a standard OIDC flow, which avoids the
   * "Required parameter is missing: response_type" that some pure-API scopes
   * trigger on this endpoint.
   */
  const browserAuth = useCallback(async (reqClientId: string): Promise<string> => {
    const scope = `openid email profile ${SYNC_SCOPE}`;
    let authUrl = "";
    try {
      authUrl = await invoke<string>("google_oauth_start", { clientId: reqClientId, scope, clientSecret });
    } catch (e: any) {
      throw new Error(`Couldn't start authorization: ${String(e?.message || e)}`);
    }
    if (!authUrl) throw new Error("Authorization could not be started.");
    // Open the auth URL with the Tauri shell plugin — the reliable cross-platform
    // way to hand a URL (including its `&` params) to the default browser.
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(authUrl);
    } catch (e: any) {
      throw new Error(`Couldn't open the browser: ${String(e?.message || e)}`);
    }
    // Poll the loopback callback for up to ~3 minutes (the Rust side exchanges
    // the code and returns the token; busy-waiting is fine at 1s cadence).
    for (let i = 0; i < 180; i++) {
      try {
        const token = await invoke<string>("google_oauth_poll", { clientId: reqClientId, clientSecret });
        if (token) return token;
      } catch (e: any) {
        throw new Error(`Authorization failed: ${String(e?.message || e)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { await invoke("google_oauth_clear"); } catch { /* ignore */ }
    return "";
  }, [clientSecret]);

  const hook = useGoogleSync({
    ready,
    getLocalEnvelope,
    onApplyDrive,
    payloadSignature: signature,
    browserAuth,
  });

  return {
    status: hook.status,
    account: hook.account,
    signedIn: hook.signedIn,
    hasConfig: hook.hasConfig,
    signIn: () => { void hook.signIn(); },
    signOut: hook.signOut,
    runSync: () => { void hook.runSync(); },
  };
}
