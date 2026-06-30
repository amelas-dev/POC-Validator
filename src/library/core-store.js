// core-store.js — on-device persistence for the single Core application manifest.
//
// The Core manifest embeds the merged corpus (file bytes), so it lives in IndexedDB (not
// localStorage). It is intentionally LOCAL-ONLY and kept in its own database, separate from
// the asset Library, so adding the Core never touches the Library's schema or its cloud
// fallback. One record, id "current". Namespaced under the project's own DB names.

const DB_NAME = 'lane-core';
const DB_VER = 1;
const STORE = 'core';
const KEY = 'current';

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => { dbp = null; });   // let the next call retry if open failed (private mode)
  return dbp;
}

async function tx(mode) {
  const db = await open();
  const t = db.transaction(STORE, mode);
  const done = new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return { store: t.objectStore(STORE), done };
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// Load the current Core manifest, or null if none is set (or storage is unavailable).
export async function getCore() {
  try {
    const { store } = await tx('readonly');
    const rec = await wrap(store.get(KEY));
    return rec ? rec.manifest : null;
  } catch { return null; }
}

// Persist (replace) the current Core manifest.
export async function putCore(manifest) {
  const { store, done } = await tx('readwrite');
  store.put({ id: KEY, manifest, updatedAt: manifest && manifest.contentHash || null });
  await done;
  return manifest;
}

// Clear the Core (the user disbands it).
export async function clearCore() {
  const { store, done } = await tx('readwrite');
  store.delete(KEY);
  await done;
}
