// Local persistence for studio projects — IndexedDB, which stores Blobs
// natively (slide frames go in as JPEG/PNG Blobs, no base64 inflation).
// Browser-only. Every operation is promisified; callers own error handling
// (and MUST console.error failures — never fail silently).

const DB_NAME = 'vhs-tik';
const DB_VERSION = 1;
const STORE = 'projects';

let dbPromise = null;

export function storageAvailable() {
  try { return typeof indexedDB !== 'undefined'; } catch { return false; }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema later, close so it isn't blocked.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB open failed')); };
    req.onblocked = () => console.warn('[tik-store] open blocked by another tab');
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

// Writes must resolve on the TRANSACTION completing, not the request: a write
// tx can still abort after request-success (the classic case is quota), and
// resolving early would report "Saved" for data that never landed.
function writeToPromise(db, op) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const req = op(t.objectStore(STORE));
    let result;
    req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || req.error || new Error('IndexedDB write failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB write aborted (storage quota?)'));
  });
}

// Insert-or-replace a full project record (see app.js serializeProject()).
export async function putProject(record) {
  const db = await openDB();
  return writeToPromise(db, (store) => store.put(record));
}

export async function getProject(id) {
  const db = await openDB();
  return requestToPromise(tx(db, 'readonly').get(id));
}

// Newest-first summaries for the library. Returns full records (thumbs are
// small; slide frames only load with the record — fine at library scale).
export async function listProjects() {
  const db = await openDB();
  const all = await requestToPromise(tx(db, 'readonly').getAll());
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteProject(id) {
  const db = await openDB();
  return writeToPromise(db, (store) => store.delete(id));
}
