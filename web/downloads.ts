/**
 * downloads.ts — IndexedDB storage for tracks downloaded onto this device
 * (from the LAN server, or from Google Drive for offline listening).
 *
 * v2 adds the bookkeeping needed for a real cache:
 *   - `size`       — bytes, for the max-cache-size budget
 *   - `lastAccess` — for LRU eviction
 *   - `pinned`     — the user explicitly marked the track "available offline",
 *                    so it is NEVER evicted
 *
 * v1 stored bare Blobs; the upgrade transaction rewrites them as records with
 * `pinned: false` so existing downloads keep working.
 */

const DB_NAME = "needmusic-downloads";
const STORE = "audio";
const VER = 2;

export interface DownloadRecord {
  blob: Blob;
  size: number;
  /** Epoch ms of the last read (playback). Drives LRU eviction. */
  lastAccess: number;
  /** Explicitly kept offline → exempt from eviction. */
  pinned: boolean;
}

export interface CacheStats {
  count: number;
  totalBytes: number;
  pinnedBytes: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
        return;
      }
      // v1 → v2: turn bare Blobs into records (kept, unpinned).
      const store = req.transaction!.objectStore(STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const value = cursor.value as unknown;
        if (value instanceof Blob) {
          store.put(
            { blob: value, size: value.size, lastAccess: Date.now(), pinned: false },
            cursor.key,
          );
        }
        cursor.continue();
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onabort = () => { db.close(); reject(t.error); };
      }),
  );
}

/** Store a downloaded audio Blob keyed by track id. */
export async function saveDownloadedAudio(
  id: string,
  blob: Blob,
  opts?: { pinned?: boolean },
): Promise<void> {
  const existing = await readRecord(id);
  const record: DownloadRecord = {
    blob,
    size: blob.size,
    lastAccess: Date.now(),
    pinned: opts?.pinned ?? existing?.pinned ?? false,
  };
  await tx("readwrite", (s) => s.put(record, id));
}

function readRecord(id: string): Promise<DownloadRecord | null> {
  return tx<DownloadRecord | undefined>("readonly", (s) => s.get(id)).then((v) => v ?? null);
}

/** Retrieve a downloaded Blob for a track id (null if not downloaded). */
export async function getDownloadedAudio(id: string): Promise<Blob | null> {
  const rec = await readRecord(id);
  if (!rec) return null;
  // Reading counts as a use, so LRU reflects actual playback.
  void tx("readwrite", (s) =>
    s.put({ ...rec, lastAccess: Date.now() }, id),
  ).catch(() => { /* best-effort */ });
  return rec.blob ?? null;
}

/** Mark a downloaded track as used now (without reading its bytes). */
export async function touchDownloadedAudio(id: string): Promise<void> {
  const rec = await readRecord(id);
  if (!rec) return;
  await tx("readwrite", (s) => s.put({ ...rec, lastAccess: Date.now() }, id));
}

/** Pin/unpin a download so eviction keeps (or may reclaim) it. */
export async function setDownloadedPinned(id: string, pinned: boolean): Promise<void> {
  const rec = await readRecord(id);
  if (!rec) return;
  await tx("readwrite", (s) => s.put({ ...rec, pinned }, id));
}

/** Track ids that are pinned (kept offline). */
export async function getPinnedIds(): Promise<Set<string>> {
  const all = await getAllMeta();
  const out = new Set<string>();
  for (const [id, m] of all) if (m.pinned) out.add(id);
  return out;
}

/** All downloaded track ids (pinned or not). */
export async function getDownloadedIds(): Promise<Set<string>> {
  const all = await getAllMeta();
  return new Set(all.keys());
}

/** Metadata for every stored download (no blobs loaded). */
export async function getAllMeta(): Promise<Map<string, Omit<DownloadRecord, "blob">>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).openCursor();
    const out = new Map<string, Omit<DownloadRecord, "blob">>();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const v = cursor.value as DownloadRecord | Blob;
        if (v instanceof Blob) {
          out.set(String(cursor.key), { size: v.size, lastAccess: 0, pinned: false });
        } else {
          out.set(String(cursor.key), {
            size: Number(v.size) || v.blob?.size || 0,
            lastAccess: Number(v.lastAccess) || 0,
            pinned: !!v.pinned,
          });
        }
        cursor.continue();
      } else {
        db.close();
        resolve(out);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** All downloaded track ids + blobs (used to restore playback on app start). */
export async function getAllDownloadedAudio(): Promise<{ id: string; blob: Blob }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).openCursor();
    const out: { id: string; blob: Blob }[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const v = cursor.value as DownloadRecord | Blob;
        const blob = v instanceof Blob ? v : v.blob;
        if (blob) out.push({ id: String(cursor.key), blob });
        cursor.continue();
      } else {
        db.close();
        resolve(out);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Remove a downloaded track (e.g. when it is deleted from the library). */
export async function removeDownloadedAudio(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Delete EVERY downloaded audio entry from IndexedDB (used by "clean everything"). */
export async function clearAllDownloadedAudio(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
}

/** Current cache usage, for the settings UI. */
export async function getCacheStats(): Promise<CacheStats> {
  const all = await getAllMeta();
  let totalBytes = 0;
  let pinnedBytes = 0;
  for (const m of all.values()) {
    totalBytes += m.size;
    if (m.pinned) pinnedBytes += m.size;
  }
  return { count: all.size, totalBytes, pinnedBytes };
}

/**
 * Enforce a maximum cache size by evicting least-recently-used entries.
 *
 * Pinned (explicitly offline) downloads are never evicted — if the pinned set
 * alone exceeds the budget, nothing more can be reclaimed and the returned list
 * is simply what fit the policy. Returns the ids that were removed, so callers
 * can revoke blob URLs / refresh UI state.
 */
export async function evictToLimit(maxBytes: number): Promise<string[]> {
  if (!(maxBytes > 0)) return [];
  const all = await getAllMeta();
  let total = 0;
  const evictable: { id: string; size: number; lastAccess: number }[] = [];
  for (const [id, m] of all) {
    total += m.size;
    if (!m.pinned) evictable.push({ id, size: m.size, lastAccess: m.lastAccess });
  }
  if (total <= maxBytes) return [];

  // Oldest access first.
  evictable.sort((a, b) => a.lastAccess - b.lastAccess);
  const removed: string[] = [];
  for (const e of evictable) {
    if (total <= maxBytes) break;
    await removeDownloadedAudio(e.id);
    total -= e.size;
    removed.push(e.id);
  }
  return removed;
}
