/**
 * useGoogleSync — a React hook that ties Google Identity Services sign-in,
 * OAuth token acquisition, and the Google Drive appDataFolder read/save cycle
 * into either the desktop (Tauri) or web app.
 *
 * Responsibilities:
 *   - loads GIS and, when a CLIENT_ID exists, initializes `google.accounts.id`.
 *   - exposes a "sign in" action that stores the account and fetches a
 *     `drive.appdata` OAuth access token, then runs the first sync.
 *   - on every change to the local state (identified by the payload signature),
 *     performs conflict resolution (timestamp-based) and pushes to Drive.
 *   - exposes `status` for loading/syncing indicators and `signOut`.
 *
 * The client id is injected into the shared layer by the hosting app
 * (`web`);
 * this hook reads `getGoogleClientId()` from the shared Drive module.
 *
 * Data flow:
 *   - `getLocalEnvelope()` builds the current local blob (must set `lastUpdated`
 *     the instant the state changed);
 *   - `onApplyDrive(blob)` receives the merged remote blob so the caller can
 *     apply it back into the app (favorites, playlists).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadGisScript,
  fetchDriveData,
  saveDriveData,
  resolveConflicts,
  cacheToken,
  getCachedToken,
  getGoogleClientId,
  hasGoogleClientId,
  SYNC_SCOPE,
  type DriveSyncEnvelope,
} from "@core/services/googleDriveSync";
import { mergeTrackLists, type SyncTrackMeta } from "@core/services/cloudsync";

export type GoogleSyncStatus =
  | { state: "idle" }
  | { state: "needs-config" }
  | { state: "unsigned" } // GIS ready, user has not signed in
  | { state: "authorizing"; detail: string }
  | { state: "syncing"; detail: string }
  | { state: "synced"; detail: string; at: string }
  | { state: "error"; detail: string };

export interface DriveAccount {
  email: string;
  name: string;
  picture: string;
}

interface UseGoogleSyncArgs {
  /** True once the app's local state has settled enough to start syncing. */
  ready: boolean;
  /** A stable snapshot of local state (may be async for DB-backed apps; receives
   *  the current token so DB-backed uploads can also push audio to Drive). */
  getLocalEnvelope: (token: string) => DriveSyncEnvelope | Promise<DriveSyncEnvelope>;
  /** Called with the resolved (winning) envelope so the caller can apply it. */
  onApplyDrive: (envelope: DriveSyncEnvelope) => boolean | void | Promise<boolean | void>;
  /**
   * A stable signature of the current local payload (must change whenever the
   * data to sync changes). Used to trigger a Drive push after the initial sync.
   */
  payloadSignature: string;
  /**
   * Optional system-browser OAuth (PKCE) provider — used on desktop where the
   * app's origin can't be an Authorized JS origin. When provided, `signIn`
   * calls this instead of the inline GIS OAuth. Returns an access token.
   */
  browserAuth?: (clientId: string, scope: string) => Promise<string>;
}

declare global {
  interface Window {
    google?: any;
  }
}

const ACCOUNT_KEY = "needmusic:gdrive:account";

function readAccount(): DriveAccount | null {
  try { const raw = sessionStorage.getItem(ACCOUNT_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeAccount(acc: DriveAccount | null): void {
  try { if (acc) sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc)); else sessionStorage.removeItem(ACCOUNT_KEY); } catch { /* ignore */ }
}

export function useGoogleSync({ ready, getLocalEnvelope, onApplyDrive, payloadSignature, browserAuth }: UseGoogleSyncArgs) {
  const [status, setStatus] = useState<GoogleSyncStatus>(() =>
    hasGoogleClientId() ? { state: "unsigned" } : { state: "needs-config" }
  );
  const [account, setAccount] = useState<DriveAccount | null>(readAccount);
  const [token, setToken] = useState<string>(getCachedToken);

  // Refs for latest values inside async callbacks.
  const tokenRef = useRef(token); tokenRef.current = token;
  const readyRef = useRef(ready); readyRef.current = ready;
  const getLocalEnvelopeRef = useRef(getLocalEnvelope); getLocalEnvelopeRef.current = getLocalEnvelope;
  const onApplyDriveRef = useRef(onApplyDrive); onApplyDriveRef.current = onApplyDrive;
  // Signature of the blob that is currently in Drive on the server (best guess).
  const driveSigRef = useRef<string>("");
  const syncedOnceRef = useRef(false);

  const setter = useCallback((next: GoogleSyncStatus) => setStatus(next), []);

  /** Drop auth and return to the signed-out state. */
  const invalidateAuth = useCallback(() => {
    cacheToken(null);
    setToken("");
    setter({ state: "unsigned" });
  }, [setter]);

  // Load GIS and initialize the identity flow (sign-in button).
  useEffect(() => {
    if (!hasGoogleClientId()) { setter({ state: "needs-config" }); return; }
    setter({ state: "unsigned" });
    loadGisScript()
      .then(() => {
        const g = window.google;
        if (!g?.accounts?.id) throw new Error("Google Identity Services unavailable");
        g.accounts.id.initialize({
          client_id: getGoogleClientId(),
          auto_select: false,
          callback: (resp: any) => {
            if (resp?.credential) {
              try {
                const payload = JSON.parse(atob(resp.credential.split(".")[1]));
                const acc: DriveAccount = { email: payload.email || "", name: payload.name || payload.email || "", picture: payload.picture || "" };
                setAccount(acc);
                writeAccount(acc);
              } catch { /* display-only decode */ }
            }
          },
        });
      })
      .catch((e: any) => setter({ state: "error", detail: String(e?.message || e) }));
    return () => { /* GIS is global; nothing to undo */ };
  }, [setter]);

  /** One full pull → resolve → apply → push cycle. Requires a valid token. */
  const runSync = useCallback(async () => {
    const tk = tokenRef.current;
    if (!tk) { setter({ state: "unsigned" }); return; }

    setter({ state: "syncing", detail: "Reading Drive…" });
    let drive: DriveSyncEnvelope | null = null;
    try {
      drive = await fetchDriveData(tk);
    } catch (e: any) {
      if (e?.name === "DriveAuthError") return invalidateAuth();
      setter({ state: "error", detail: `Read failed: ${e?.message || e}` });
      return;
    }

    if (!readyRef.current) return; // app not settled; retry when it is

    const local = await getLocalEnvelopeRef.current(tokenRef.current);
    let winner = resolveConflicts(local, drive);

    // Never let one device's empty track list clobber another device's uploaded
    // audio references: union both sides' tracks, keeping entries with driveFileId.
    const mergedTracks = mergeTrackLists(
      ((local?.payload as any)?.tracks ?? []) as SyncTrackMeta[],
      ((drive?.payload as any)?.tracks ?? []) as SyncTrackMeta[],
    );
    const payload = { ...(winner.payload as object), tracks: mergedTracks };
    winner = { ...winner, payload } as DriveSyncEnvelope;

    // If Drive is behind (or missing), push the winner up.
    if (!drive || JSON.stringify(winner) !== JSON.stringify(drive)) {
      setter({ state: "syncing", detail: "Syncing to Drive…" });
      try {
        await saveDriveData(tk, winner);
      } catch (e: any) {
        if (e?.name === "DriveAuthError") return invalidateAuth();
        setter({ state: "error", detail: `Save failed: ${e?.message || e}` });
        return;
      }
    }

    // Apply the resolved blob locally (favorites/playlists reconciliation).
    try { await onApplyDriveRef.current(winner); } catch { /* caller handles */ }
    driveSigRef.current = JSON.stringify(winner.payload ?? null);
    syncedOnceRef.current = true;
    setter({ state: "synced", detail: "Synced ✓", at: new Date().toISOString() });
  }, [invalidateAuth, setter]);

  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;

  /**
   * "Sign in with Google" action (must run from a user gesture): request a
   * `drive.appdata` access token via GIS OAuth, then run the first sync.
   */
  const signIn = useCallback(async () => {
    if (!hasGoogleClientId()) { setter({ state: "needs-config" }); return; }
    const clientId = getGoogleClientId();
    // Desktop / not-origin-safe environments: use system-browser OAuth (PKCE).
    if (browserAuth) {
      setter({ state: "authorizing", detail: "Open the browser to authorize…" });
      try {
        const accessToken = await browserAuth(clientId, SYNC_SCOPE);
        if (!accessToken) { setter({ state: "error", detail: "Authorization cancelled or timed out." }); return; }
        cacheToken(accessToken);
        setToken(accessToken);
      } catch (e: any) {
        setter({ state: "error", detail: String(e?.message || e) });
      }
      return;
    }
    try {
      await loadGisScript();
      const g = window.google;
      if (!g?.accounts?.oauth2?.initTokenClient) throw new Error("GIS OAuth unavailable");

      setter({ state: "authorizing", detail: "Requesting access…" });
      const tokenClient = g.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SYNC_SCOPE,
        prompt: "",
        callback: (resp: any) => {
          if (resp?.error) { setter({ state: "error", detail: `Google auth error: ${resp.error}` }); return; }
          if (!resp?.access_token) { setter({ state: "error", detail: "No access token returned — did you allow access?" }); return; }
          cacheToken(resp.access_token);
          setToken(resp.access_token);
          if (resp.id_token) {
            try {
              const payload = JSON.parse(atob(resp.id_token.split(".")[1]));
              const acc: DriveAccount = { email: payload.email || "", name: payload.name || payload.email || "", picture: payload.picture || "" };
              setAccount(acc); writeAccount(acc);
            } catch { /* ignore */ }
          }
          // The autosync effect (below) runs the initial pull once `token` is set
          // and `ready` is true, so no direct call here.
        },
      });
      tokenClient.requestAccessToken();
    } catch (e: any) {
      setter({ state: "error", detail: String(e?.message || e) });
    }
  }, [setter, browserAuth]);

  /** Auto-run an initial sync if we restored a cached token (re-open after login). */
  useEffect(() => {
    if (!ready || !token || syncedOnceRef.current) return;
    runSyncRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, token]);

  /**
   * Watch for local state changes while signed-in: when `payloadSignature`
   * changes, push the current local state up to Drive (skipping pushes when
   * the signature matches what Drive already holds).
   */
  const lastSeenSig = useRef<string>("");
  const lastPushedSig = useRef<string>("");
  useEffect(() => {
    if (!ready || !token || !syncedOnceRef.current) return;
    if (payloadSignature === lastSeenSig.current) return;
    lastSeenSig.current = payloadSignature;
    if (payloadSignature === driveSigRef.current) return; // Drive already up to date
    if (payloadSignature === lastPushedSig.current) return; // already queued/just pushed

    lastPushedSig.current = payloadSignature;
    setter({ state: "syncing", detail: "Updating Drive…" });
    (async () => {
      const local = await getLocalEnvelopeRef.current(tokenRef.current);
      return saveDriveData(tokenRef.current, local);
    })()
      .then(() => {
        driveSigRef.current = payloadSignature;
        setter({ state: "synced", detail: "Synced ✓", at: new Date().toISOString() });
      })
      .catch((e: any) => {
        if (e?.name === "DriveAuthError") return invalidateAuth();
        setter({ state: "error", detail: `Save failed: ${e?.message || e}` });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadSignature, token, ready, invalidateAuth, setter]);

  const signOut = useCallback(() => {
    invalidateAuth();
    writeAccount(null);
    setAccount(null);
    try { window.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* ignore */ }
  }, [invalidateAuth]);

  return { status, account, signedIn: !!token, token, signIn, signOut, runSync, hasConfig: hasGoogleClientId() };
}
