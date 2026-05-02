// Persist the user's chosen save folder (FileSystemDirectoryHandle) across
// page reloads via IndexedDB. localStorage CANNOT store these handles — they
// only survive structured-clone serialization, which IndexedDB supports.
//
// On the next page load we restore the handle and call queryPermission() to
// check if the browser still has permission. Chrome usually keeps "writable"
// permissions for a folder you've used recently without re-prompting; if it's
// downgraded to 'prompt' we silently fall back (the user re-picks via the
// existing toolbar / device-settings flow).

const DB_NAME = 'vhsg_handles';
const STORE = 'handles';
const DIR_KEY = 'directory';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirectoryHandle(handle) {
  if (!handle) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[handle-store] could not persist directory handle:', e.message);
  }
}

export async function loadDirectoryHandle() {
  try {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(DIR_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch (e) {
    console.warn('[handle-store] could not load directory handle:', e.message);
    return null;
  }
}

export async function clearDirectoryHandle() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[handle-store] could not clear directory handle:', e.message);
  }
}

// Returns 'granted' | 'prompt' | 'denied'. 'granted' means we can use the
// handle without re-prompting; 'prompt' means we'd need to call
// requestPermission (which itself requires a user gesture, so we usually
// just fall back to the existing folder-pick UI rather than try silently).
export async function queryHandlePermission(handle, mode = 'readwrite') {
  if (!handle || typeof handle.queryPermission !== 'function') return 'prompt';
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return 'prompt';
  }
}

// Best-effort silent re-grant. Chrome will only succeed silently if the
// browser's heuristic agrees ("recently used", same origin, etc.); otherwise
// the call resolves to 'prompt' and we leave the user-pick path in charge.
export async function tryRequestHandlePermission(handle, mode = 'readwrite') {
  if (!handle || typeof handle.requestPermission !== 'function') return 'prompt';
  try {
    return await handle.requestPermission({ mode });
  } catch {
    return 'prompt';
  }
}
