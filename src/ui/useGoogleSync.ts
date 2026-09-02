/**
 * useGoogleSync — a React hook that ties Google Identity Services sign-in,
 * OAuth token acquisition, and the per-device Drive file sync cycle into
 * either the desktop (Tauri) or web app.
 *
 * Sync model (v2): every device owns ONE file `sync-<deviceId>.json` in the
 * Drive appDataFolder and only writes to it (no shared-file write races). Each
 * cycle this hook:
 *   1. lists all device files, downloads the OTHER devices' files,
 *   2. merges them deterministically via `mergeDeviceFiles`,
 *   3. hands the merged state to the host (`onApplyMerged`) to apply locally,
 *   4. asks the host for its own fresh file (`getOwnFile`) and, if it changed
 *      since the last push (or the last push was ours), uploads it.
 *
 * The merge is deterministic, so given the same set of files the result is the
 * same on every device — no flapping, no random track counts.
 *
 * The host provides:
 *   - getOwnFile(token)      → this device's current `DeviceSyncFile`
 *   - onApplyMerged(merged)  → apply the merged state back into the app
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadGisScript,
  listSyncFiles,
  fetchDeviceFile,
  saveOwnSyncFile,
  cacheToken,
  getCachedToken,
  clearCachedCredentials,
  getGoogleClientId,
  hasGoogleClientId,
  SYNC_SCOPE,
} from "@core/services/googleDriveSync";
import { mergeDeviceFiles, type DeviceSyncFile, type MergedState } from "@core/services/cloudsync";

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

export interface SyncDevice {
  deviceId: string;
}

interface UseGoogleSyncArgs {
  /** True once the app's local state has settled enough to start syncing. */
  ready: boolean;
  /** Stable id of THIS device (used for its own sync-file name). */
  deviceId: string;
  /** Build this device's fresh sync file (async; may upload audio → Drive). */
  getOwnFile: (token: string) => Promise<DeviceSyncFile>;
  /** Apply a merged cross-device state back into this device. Returns true if
   *  anything changed (so the host UI can refresh). */
  onApplyMerged: (merged: MergedState, token: string) => boolean | void | Promise<boolean | void>;
  /** A stable signature of the current LOCAL state. When it changes, we push
   *  our file again (so other devices see our changes sooner). */
  payloadSignature: string;
  /**
   * Optional system-browser OAuth (PKCE) provider — used on desktop where the
   * app's origin can't be an Authorized JS origin. When provided, `signIn`
   * calls this instead of the inline GIS OAuth. Returns an access token.
   */
  browserAuth?: (clientId: string, scope: string) => Promise<string>;
  /**
   * Optional refresh provider used to silently renew an expired access token
   * (desktop passes a Rust-backed refresh; web may omit and fall back to re-auth).
   */
  refreshAccessToken?: () => Promise<string>;
}

declare global {
  interface Window {
    google?: any;
  }
}

const ACCOUNT_KEY = "needmusic:gdrive:account";

function readAccount(): DriveAccount | null {
  try { const raw = localStorage.getItem(ACCOUNT_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeAccount(acc: DriveAccount | null): void {
  try { if (acc) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc)); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* ignore */ }
}

export function useGoogleSync({
  ready,
  deviceId,
  getOwnFile,
  onApplyMerged,
  payloadSignature,
  browserAuth,
  refreshAccessToken,
}: UseGoogleSyncArgs) {
  const [status, setStatus] = useState<GoogleSyncStatus>(() =>
    hasGoogleClientId() ? { state: "unsigned" } : { state: "needs-config" }
  );
  const [account, setAccount] = useState<DriveAccount | null>(readAccount);
  const [token, setToken] = useState<string>(getCachedToken);

  const tokenRef = useRef(token); tokenRef.current = token;
  const readyRef = useRef(ready); readyRef.current = ready;
  const getOwnFileRef = useRef(getOwnFile); getOwnFileRef.current = getOwnFile;
  const onApplyMergedRef = useRef(onApplyMerged); onApplyMergedRef.current = onApplyMerged;
  const refreshAccessTokenRef = useRef(refreshAccessToken); refreshAccessTokenRef.current = refreshAccessToken;
  const deviceIdRef = useRef(deviceId); deviceIdRef.current = deviceId;
  // Our own file's Drive id (cached so we skip the find on later pushes).
  const ownFileIdRef = useRef<string | null>(null);
  // Signature of the last state WE pushed. If local state changes → push again.
  const pushedLocalSigRef = useRef<string>("");
  // Guards against infinite retry loops when a fresh token is also rejected.
  const authRetriedRef = useRef(false);

  const setter = useCallback((next: GoogleSyncStatus) => setStatus(next), []);

  /** Drop auth and return to the signed-out state. */
  const invalidateAuth = useCallback(() => {
    clearCachedCredentials();
    setToken("");
    setter({ state: "unsigned" });
  }, [setter]);

  /** Renew the access token via the refresh provider (desktop). */
  const refreshTokenNow = useCallback(async (): Promise<boolean> => {
    const provider = refreshAccessTokenRef.current;
    if (!provider) return false;
    if (authRetriedRef.current) return false;
    try {
      const access = await provider();
      if (!access) return false;
      cacheToken(access);
      tokenRef.current = access;
      setToken(access);
      authRetriedRef.current = true;
      return true;
    } catch {
      return false;
    }
  }, [setToken]);

  /** Load GIS and initialize the identity flow (sign-in button). */
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

  // Auto-restore a previous session: if we have a saved account but no valid
  // token, silently renew it so the user stays signed in across restarts.
  const restoreRef = useRef(false);
  useEffect(() => {
    if (restoreRef.current) return;
    restoreRef.current = true;
    if (!hasGoogleClientId()) return;
    if (getCachedToken()) return;
    if (!readAccount()) return;

    (async () => {
      if (refreshAccessToken) {
        try {
          const access = await refreshAccessToken();
          if (access) { cacheToken(access); setToken(access); }
        } catch { /* expired — user re-signs in */ }
        return;
      }
      try {
        await loadGisScript();
        const g = window.google;
        if (!g?.accounts?.oauth2?.initTokenClient) return;
        const client = g.accounts.oauth2.initTokenClient({
          client_id: getGoogleClientId(),
          scope: SYNC_SCOPE,
          prompt: "",
          callback: (resp: any) => {
            if (resp?.access_token) {
              cacheToken(resp.access_token, resp.expires_in || 3600);
              setToken(resp.access_token);
            }
          },
        });
        client.requestAccessToken();
      } catch { /* ignore — user re-signs in */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One full sync cycle: push our own fresh file first (local edits reach Drive
   * BEFORE we apply anything remote), then list → download the other devices'
   * files → merge (including OUR OWN file) → apply. Deterministic and safe to
   * run periodically; the "push first" order means a just-made local change is
   * never wiped out by another device's older snapshot during apply.
   */
  const syncCycle = useCallback(async () => {
    const tk = tokenRef.current;
    if (!tk) return;
    if (!readyRef.current) return;

    // 0) Push our own file (if it changed since our last push, or never pushed).
    let ourFile: DeviceSyncFile;
    try {
      ourFile = await getOwnFileRef.current(tk);
      const ourSig = signatureOf(ourFile);
      if (ourSig !== pushedLocalSigRef.current) {
        const id = await saveOwnSyncFile(tk, ourFile, ownFileIdRef.current);
        ownFileIdRef.current = id;
        pushedLocalSigRef.current = ourSig;
      }
    } catch (e: any) {
      if (e?.name === "DriveAuthError") {
        if (await refreshTokenNow()) return syncCycle();
        return invalidateAuth();
      }
      throw e; // transient — the next periodic cycle retries
    }
    authRetriedRef.current = false;

    // 1) List all device files and fetch the others'.
    const files: DeviceSyncFile[] = [ourFile]; // include OUR OWN local file
    try {
      const listed = await listSyncFiles(tk);
      const ownId = listed.find((f) => f.deviceId === deviceIdRef.current);
      if (ownId) ownFileIdRef.current = ownId.fileId;
      for (const f of listed) {
        if (f.deviceId === deviceIdRef.current) continue; // use our local file
        const parsed = await fetchDeviceFile(tk, f.fileId).catch(() => null);
        if (parsed) files.push(parsed);
      }
    } catch (e: any) {
      if (e?.name === "DriveAuthError") {
        if (await refreshTokenNow()) return syncCycle();
        return invalidateAuth();
      }
      throw e;
    }
    authRetriedRef.current = false;

    // 2) Merge deterministically (includes our own file → local edits survive).
    const merged = mergeDeviceFiles(files);

    // 3) Apply locally.
    await onApplyMergedRef.current(merged, tk);
  }, [invalidateAuth, refreshTokenNow]);

  const syncCycleRef = useRef(syncCycle);
  syncCycleRef.current = syncCycle;

  /**
   * Simple periodic sync: every 20s run one full deterministic cycle. No
   * Changes API (which was a source of instability) — a fresh merge of all
   * device files is cheap and always converges.
   */
  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;
    let running = false;

    const run = async () => {
      if (running) return;
      running = true;
      try { await syncCycleRef.current(); } catch (e: any) {
        if (e?.name === "DriveAuthError") { /* already handled in cycle */ }
        else setter({ state: "error", detail: String(e?.message || e) });
      } finally { running = false; }
    };

    // First sync shortly after sign-in.
    const t0 = window.setTimeout(() => { if (!cancelled) void run(); }, 500);
    const id = window.setInterval(() => { if (!cancelled) void run(); }, 20000);
    return () => { cancelled = true; window.clearTimeout(t0); window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, token, payloadSignature]);

  /**
   * "Sign in with Google" action (must run from a user gesture).
   */
  const signIn = useCallback(async () => {
    if (!hasGoogleClientId()) { setter({ state: "needs-config" }); return; }
    const clientId = getGoogleClientId();
    if (browserAuth) {
      setter({ state: "authorizing", detail: "Open the browser to authorize…" });
      try {
        const accessToken = await browserAuth(clientId, SYNC_SCOPE);
        if (!accessToken) { setter({ state: "error", detail: "Authorization cancelled or timed out." }); return; }
        cacheToken(accessToken);
        setToken(accessToken);
        setter({ state: "synced", detail: "Signed in — syncing…", at: new Date().toISOString() });
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
          cacheToken(resp.access_token, resp.expires_in || 3600);
          setToken(resp.access_token);
          setter({ state: "synced", detail: "Signed in — syncing…", at: new Date().toISOString() });
          if (resp.id_token) {
            try {
              const payload = JSON.parse(atob(resp.id_token.split(".")[1]));
              const acc: DriveAccount = { email: payload.email || "", name: payload.name || payload.email || "", picture: payload.picture || "" };
              setAccount(acc); writeAccount(acc);
            } catch { /* ignore */ }
          }
        },
      });
      tokenClient.requestAccessToken();
    } catch (e: any) {
      setter({ state: "error", detail: String(e?.message || e) });
    }
  }, [setter, browserAuth]);

  const signOut = useCallback(() => {
    invalidateAuth();
    writeAccount(null);
    setAccount(null);
    ownFileIdRef.current = null;
    pushedLocalSigRef.current = "";
    try { window.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* ignore */ }
  }, [invalidateAuth]);

  return {
    status,
    account,
    signedIn: !!token,
    token,
    signIn,
    signOut,
    runSync: () => { void syncCycleRef.current(); },
    upload: () => { void syncCycleRef.current(); },
    download: () => { void syncCycleRef.current(); },
    hasConfig: hasGoogleClientId(),
  };
}

/** Stable, compact signature of a device's pushable state. */
function signatureOf(file: DeviceSyncFile): string {
  // deletedTracks are sorted; sort tracks/favorites/playlists deterministically.
  const fav = [...file.favorites]
    .sort((a, b) => a.songKey.localeCompare(b.songKey))
    .map((x) => `${x.songKey}:${x.fav}:${x.ts}`);
  const pl = [...file.playlists]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((x) => `${x.id}:${x.name}:${[...x.trackKeys].sort().join("|")}:${x.ts}`);
  const tr = file.tracks
    .map((x) => `${x.songKey}:${x.driveFileId ?? ""}`)
    .sort();
  return JSON.stringify({ tr, del: file.deletedTracks, fav, pl });
}
