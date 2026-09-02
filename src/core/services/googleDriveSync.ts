/**
 * GoogleDriveSync — a thin, self-contained layer that uses the user's own
 * Google Drive `appDataFolder` as a small, free, cross-device key/value
 * backend for syncing NeedMusic state (favorites, playlists, metadata).
 *
 * Storage target: Google Drive File API v3, scope `drive.appdata` (non-sensitive),
 * via the modern Google Identity Services (GIS) library (`google.accounts.id`).
 *
 * The `appDataFolder` is a special folder only your app can see — invisible in
 * the user's Drive UI and isolated per-client-id — which makes it ideal for
 * app-owned sync blobs. No quota is charged to the user's visible Drive quota.
 *
 * Data contract: each device owns a private file (`sync-<deviceId>.json`) and
 * writes only to it; the merge of all devices' files is done deterministically
 * in `cloudsync` (see `mergeDeviceFiles`).
 */

import type { DeviceSyncFile } from "./cloudsync";

export const SYNC_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
/** Each device owns ONE file named `sync-<deviceId>.json` in the appDataFolder. */
export const SYNC_FILE_PREFIX = "sync-";
export const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

/* ─── CLIENT_ID (shared, injected by each build) ────────────────────────── */

let configuredClientId = "";

/**
 * Configure the Google OAuth Web client id. Called at startup by the web build
 * (from `import.meta.env.VITE_GOOGLE_CLIENT_ID`) and the desktop build (from
 * its settings/constant). Kept out of `googleConfig.ts` so the shared Drive
 * layer doesn't depend on Vite's `import.meta.env` typing.
 */
export function setGoogleClientId(id: string): void {
  configuredClientId = (id || "").trim();
}

export function getGoogleClientId(): string {
  return configuredClientId;
}

/** True once a (non-empty) client id is configured. */
export function hasGoogleClientId(): boolean {
  return configuredClientId.trim().length > 0;
}

/* ─── Types ─────────────────────────────────────────────────────────────── */

/** Minimal Drive v3 file objects relevant to us. */
interface DriveFile {
  id: string;
  name: string;
  size?: string;
}

/* ─── GIS script loading ────────────────────────────────────────────────── */

let gisLoadPromise: Promise<void> | null = null;

/** Load + evaluate the Google Identity Services client script once. */
export function loadGisScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as any;
  if (w.google?.accounts?.id) return Promise.resolve();

  if (!gisLoadPromise) {
    gisLoadPromise = new Promise<void>((resolve, reject) => {
      const existing = document.getElementById("gis-client-script");
      if (existing) {
        if (existing.hasAttribute("data-loaded")) return resolve();
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity Services")));
        return;
      }
      const s = document.createElement("script");
      s.id = "gis-client-script";
      s.src = GIS_SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => { s.setAttribute("data-loaded", "1"); resolve(); };
      s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
      document.head.appendChild(s);
    });
  }
  return gisLoadPromise;
}

/* ─── OAuth token cache ─────────────────────────────────────────────────── */

const TOKEN_KEY = "needmusic:gdrive:token";
const TOKEN_EXPIRES_KEY = "needmusic:gdrive:token_expires";
const REFRESH_KEY = "needmusic:gdrive:refresh";

/** Persist the access token (and expiry) in localStorage so the user stays
 *  signed in across app restarts. `expiresInSec` is from OAuth; 0/absent = unknown. */
export function cacheToken(token: string | null, expiresInSec?: number): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      if (expiresInSec && expiresInSec > 0) {
        localStorage.setItem(TOKEN_EXPIRES_KEY, String(Date.now() + expiresInSec * 1000));
      } else {
        localStorage.removeItem(TOKEN_EXPIRES_KEY);
      }
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_KEY);
    }
  } catch { /* storage unavailable */ }
}

/** Return a cached token from the previous app load, if any and not expired. */
export function getCachedToken(): string {
  try {
    const exp = localStorage.getItem(TOKEN_EXPIRES_KEY);
    if (exp && Number(exp) && Number(exp) <= Date.now()) return ""; // expired
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch { return ""; }
}

/** Access token expiry timestamp (ms), or 0 if unknown/not stored. */
export function getCachedTokenExpiry(): number {
  try { return Number(localStorage.getItem(TOKEN_EXPIRES_KEY)) || 0; } catch { return 0; }
}

/** Persist a refresh token (allows silent re-auth after the access token expires). */
export function cacheRefreshToken(refresh: string | null): void {
  try {
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    else localStorage.removeItem(REFRESH_KEY);
  } catch { /* ignore */ }
}

export function getCachedRefreshToken(): string {
  try { return localStorage.getItem(REFRESH_KEY) || ""; } catch { return ""; }
}

/** Clear every cached credential (token, refresh, expires). */
export function clearCachedCredentials(): void {
  cacheToken(null);
  cacheRefreshToken(null);
}

/* ─── Drive REST helpers ────────────────────────────────────────────────── */

const DRIVE_API = "https://www.googleapis.com/drive/v3";

async function gfetch(token: string, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${DRIVE_API}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((init?.body && !(init.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) throw new DriveAuthError("Access token expired — please sign in again.");
  if (!res.ok) {
    // Surface a readable reason when the API tells us one.
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.message) detail = `${body.error.message} (${detail})`;
    } catch { /* non-JSON error body */ }
    throw new DriveApiError(detail, res.status);
  }
  return res;
}

/** List files in appDataFolder, searching by name. */
async function findAppDataFile(token: string, name: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`name='${name}' and 'appDataFolder' in parents and trashed=false`);
  const res = await gfetch(token, `/files?spaces=appDataFolder&q=${q}&fields=files(id,name,size)&pageSize=1`);
  const data = await res.json();
  const files: DriveFile[] = data?.files ?? [];
  return files[0] ?? null;
}

/**
 * Create an empty file (metadata only) inside appDataFolder and return its id.
 * Content is filled in a second `uploadType=media` call, so no multipart
 * hand-assembly is needed (which Drive's JSON endpoints reject).
 */
async function createMetadataFile(token: string, name: string): Promise<DriveFile> {
  const res = await gfetch(token, "/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    body: JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" }),
  });
  const file = await res.json();
  if (!file?.id) throw new DriveApiError("Create returned no file id.", 0);
  return { id: file.id, name: file.name ?? name };
}

/**
 * Upload raw file CONTENT to an existing file via /upload/...?uploadType=media
 * (media-only upload). body is the literal JSON string — no multipart envelope,
 * avoiding the "Invalid JSON payload" / boundary parsing failure entirely.
 */
async function uploadMedia(token: string, fileId: string, content: string): Promise<void> {
  const url = `${DRIVE_API.replace("/drive/", "/upload/drive/")}/files/${encodeURIComponent(fileId)}?uploadType=media`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: content,
  });
  if (res.status === 401) throw new DriveAuthError("Access token expired — please sign in again.");
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error?.message) detail = `${b.error.message} (${detail})`; } catch { /* ignore */ }
    throw new DriveApiError(detail, res.status);
  }
}

/** Download a file's full media content (alt=media). */
async function downloadFileContent(token: string, fileId: string): Promise<string> {
  const res = await gfetch(token, `/files/${encodeURIComponent(fileId)}?alt=media`);
  return res.text();
}

/**
 * Download a file's binary media content (alt=media) as an ArrayBuffer.
 */
async function downloadBinaryContent(token: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new DriveAuthError("Access token expired — please sign in again.");
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error?.message) detail = `${b.error.message} (${detail})`; } catch { /* ignore */ }
    throw new DriveApiError(detail, res.status);
  }
  return res.arrayBuffer();
}

/**
 * Upload binary audio bytes to the appDataFolder under a stable name
 * (`audio__<hash>.bin`) and return the resulting Drive file id.
 * Creates the file if absent, else overwrites its content (metadata unchanged).
 */
export async function uploadAudioFile(
  token: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const existing = await findAppDataFile(token, name);
  let fileId: string;
  if (existing) {
    fileId = existing.id;
  } else {
    const created = await createMetadataFileFor(token, name, mime);
    fileId = created.id;
  }
  await uploadMediaBytes(token, fileId, bytes, mime);
  return fileId;
}

/** Create a file in appDataFolder with a given mime type (used for audio) and return id. */
async function createMetadataFileFor(token: string, name: string, mime: string): Promise<DriveFile> {
  const res = await gfetch(token, "/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    body: JSON.stringify({ name, parents: ["appDataFolder"], mimeType: mime || "application/octet-stream" }),
  });
  const file = await res.json();
  if (!file?.id) throw new DriveApiError("Create returned no file id.", 0);
  return { id: file.id, name: file.name ?? name };
}

/** Upload raw binary bytes to a file via uploadType=media (no multipart). */
async function uploadMediaBytes(token: string, fileId: string, bytes: Uint8Array, mime: string): Promise<void> {
  const url = `${DRIVE_API.replace("/drive/", "/upload/drive/")}/files/${encodeURIComponent(fileId)}?uploadType=media`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mime || "application/octet-stream",
    },
    body: bytes as unknown as BodyInit,
  });
  if (res.status === 401) throw new DriveAuthError("Access token expired — please sign in again.");
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error?.message) detail = `${b.error.message} (${detail})`; } catch { /* ignore */ }
    throw new DriveApiError(detail, res.status);
  }
}

/** Download audio bytes for a Drive file id (the audio stored in appDataFolder). */
export async function downloadAudioFile(token: string, fileId: string): Promise<ArrayBuffer> {
  return downloadBinaryContent(token, fileId);
}

/* ─── Public API ────────────────────────────────────────────────────────── */

/**
 * Search the user's `appDataFolder` for `app_data.json`. If present, download
 * its content (`alt=media`) and return the parsed envelope; otherwise null.
 */
/* ─── Per-device sync files (v2 model) ──────────────────────────────────── */

/**
 * List every device's sync file in the appDataFolder. Returns each file's id
 * plus the deviceId extracted from its `sync-<deviceId>.json` name.
 */
export async function listSyncFiles(token: string): Promise<{ fileId: string; deviceId: string }[]> {
  const q = encodeURIComponent(`'appDataFolder' in parents and trashed=false`);
  const res = await gfetch(token, `/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=1000`);
  const data = await res.json();
  const files: DriveFile[] = data?.files ?? [];
  return files
    .filter((f) => typeof f.name === "string" && f.name.startsWith(SYNC_FILE_PREFIX) && f.name.endsWith(".json"))
    .map((f) => ({ fileId: f.id, deviceId: f.name.slice(SYNC_FILE_PREFIX.length, -".json".length) }));
}

/** Download and parse one device's sync file (null when missing/corrupt). */
export async function fetchDeviceFile(token: string, fileId: string): Promise<DeviceSyncFile | null> {
  const raw = await downloadFileContent(token, fileId);
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DeviceSyncFile;
  } catch {
    return null; // corrupt/legacy blob — ignore
  }
}

/**
 * Create or update THIS device's own `sync-<deviceId>.json`. Only ever touches
 * this device's file, so concurrent devices never race on the same file.
 * Returns the file id (caller caches it to skip the find on the next push).
 */
export async function saveOwnSyncFile(
  token: string,
  file: DeviceSyncFile,
  existingFileId?: string | null,
): Promise<string> {
  const content = JSON.stringify(file);
  const name = `${SYNC_FILE_PREFIX}${file.deviceId}.json`;
  if (existingFileId) {
    await uploadMedia(token, existingFileId, content);
    return existingFileId;
  }
  const existing = await findAppDataFile(token, name);
  if (existing) {
    await uploadMedia(token, existing.id, content);
    return existing.id;
  }
  const created = await createMetadataFile(token, name);
  await uploadMedia(token, created.id, content);
  return created.id;
}

/** List every file currently in the appDataFolder (used for a full wipe). */
async function listAllAppDataFiles(token: string): Promise<DriveFile[]> {
  const res = await gfetch(token, `/files?spaces=appDataFolder&fields=files(id,name)&pageSize=1000`);
  const data = await res.json();
  return (data?.files ?? []) as DriveFile[];
}

/**
 * Permanently delete ALL data stored in this app's Google Drive appDataFolder —
 * the `app_data.json` sync envelope plus every uploaded audio file. Also clears
 * the locally-cached Drive sign-in/token so the app returns to a clean, unsigned
 * state. Use this to fully reset cross-device sync ("clean everything").
 * Throws DriveAuthError on 401 (caller should invalidate auth).
 */
export async function clearAllDriveData(
  token: string,
  clearLocalAuth: () => void,
): Promise<void> {
  const files = await listAllAppDataFiles(token);
  for (const f of files) {
    // DELETE removes the file permanently (no trash in appDataFolder).
    const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(f.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new DriveAuthError("Access token expired — please sign in again.");
    if (!res.ok && res.status !== 404) {
      const detail = `HTTP ${res.status}`;
      throw new DriveApiError(detail, res.status);
    }
  }
  // Clear local tokens/account/release the session so we start unsigned.
  clearCachedCredentials();
  clearLocalAuth();
}


/* ─── Errors ────────────────────────────────────────────────────────────── */

export class DriveApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
  }
}

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveAuthError";
  }
}
