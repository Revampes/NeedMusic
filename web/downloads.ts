/**
 * downloads.ts — IndexedDB storage for tracks downloaded from the computer
 * onto the phone. Downloaded audio is stored as Blobs so playback uses a
 * local copy (no LAN streaming quirks, works offline within the session).
 */

const DB_NAME = "needmusic-downloads";
const STORE = "audio";
const VER = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a downloaded audio Blob keyed by track id. */
export async function saveDownloadedAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Retrieve a downloaded Blob for a track id (null if not downloaded). */
export async function getDownloadedAudio(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => { db.close(); resolve((req.result as Blob) ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** All downloaded track ids + blobs (used to restore playback on app start). */
export async function getAllDownloadedAudio(): Promise<{ id: string; blob: Blob }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    const out: { id: string; blob: Blob }[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ id: String(cursor.key), blob: cursor.value as Blob });
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
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
