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
 * Data contract: this module is intentionally generic. Callers provide the
 * JSON `payload` they want persisted (e.g. `{ tracks, playlists, lastUpdated, deviceId }`).
 * Conflict resolution is timestamp-based on a top-level `lastUpdated` field.
 */

export const SYNC_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const SYNC_FILE_NAME = "app_data.json";
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

export interface DriveSyncEnvelope {
  /** ISO-8601 timestamp of the last write — used for conflict resolution. */
  lastUpdated: string;
  /** Stable id of the last device/instance that wrote this blob. */
  deviceId: string;
  /** The app payload to merge/overwrite (opaque to this module). */
  payload: unknown;
}

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

/** Persist the short-lived access token in memory + sessionStorage. */
export function cacheToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

/** Return a cached token from the previous page load, if any. */
export function getCachedToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
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
export async function fetchDriveData(token: string): Promise<DriveSyncEnvelope | null> {
  const file = await findAppDataFile(token, SYNC_FILE_NAME);
  if (!file) return null;
  const raw = await downloadFileContent(token, file.id);
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DriveSyncEnvelope;
  } catch {
    // Corrupt/legacy blob — treat as absent so a clean one is written on save.
    return null;
  }
}

/**
 * Persist `payload` into `app_data.json` in `appDataFolder`.
 * - If the file already exists → content is updated (media upload).
 * - If it does not → create (with `parents: ['appDataFolder']`) then fill content.
 * Content is written through the `/upload/...?uploadType=media` endpoint with a
 * plain JSON body (no multipart), which Google accepts reliably.
 */
export async function saveDriveData(
  token: string,
  envelope: DriveSyncEnvelope,
): Promise<void> {
  const content = JSON.stringify(envelope);
  const existing = await findAppDataFile(token, SYNC_FILE_NAME);
  if (existing) {
    await uploadMedia(token, existing.id, content);
  } else {
    const created = await createMetadataFile(token, SYNC_FILE_NAME);
    await uploadMedia(token, created.id, content);
  }
}

/**
 * Basic timestamp-based merge: the newer `lastUpdated` wins. When timestamps
 * are (near) equal, deeper-than-a-field merge is intentionally avoided — the
 * local copy wins to guarantee convergence (both devices end on the same blob).
 *
 * Ties are broken by deviceId so that two devices that write in the same
 * millisecond still converge deterministically.
 */
export function resolveConflicts(
  localData: DriveSyncEnvelope | null,
  driveData: DriveSyncEnvelope | null,
): DriveSyncEnvelope {
  if (!localData) return driveData!;
  if (!driveData) return localData;

  const tLocal = parseTs(localData.lastUpdated);
  const tDrive = parseTs(driveData.lastUpdated);
  if (tDrive > tLocal) return driveData;
  if (tLocal > tDrive) return localData;
  // Equal timestamps: deterministic tie-break so both converge to one blob.
  return (driveData.deviceId || "") > (localData.deviceId || "") ? driveData : localData;
}

/** Prefer the timestamps of a and b; equal when both null (fresh). */
function parseTs(ts?: string): number {
  if (!ts) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
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
