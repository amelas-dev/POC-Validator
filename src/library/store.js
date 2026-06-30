// library/store.js — the on-device asset Library (IndexedDB).
//
// Lane's promise is read-only: your code is never *changed*. The Library adds an
// opt-in seam to it — when you check a tool, the file(s) you handed over are kept
// here so you can come back, re-check, download, or remove them. Everything lives
// in this browser, on this device; nothing is uploaded by saving to the Library.
//
// localStorage already backs the lightweight "recent checks" record, but it caps
// near 5 MB and can't hold file bytes — so the Library uses IndexedDB, which stores
// Blob/File objects natively and has room for real uploads.

import {
  isSignedIn,
  listAssetsCloud, putAssetCloud, getAssetCloud,
  deleteAssetCloud, clearAssetsCloud, countAssetsCloud,
} from '../cloud/supabase.js';

const DB_NAME = 'lane-library';
const DB_VER = 1;
const STORE = 'assets';

let dbp = null;

// When the user is signed in, the Library is backed by their cloud account
// (Supabase Storage + table) instead of this device's IndexedDB. Same API either
// way, so callers don't change. Signed out → on-device, exactly as before.
const cloud = () => isSignedIn();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If opening fails (private mode, blocked storage) let the next call try again.
  dbp.catch(() => { dbp = null; });
  return dbp;
}

// One small transaction helper. Returns the live object store plus a `done`
// promise that settles when the transaction commits (so writes are durable).
async function tx(mode) {
  const db = await open();
  const t = db.transaction(STORE, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return { store: t.objectStore(STORE), done };
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// Whether on-device storage is usable at all (degrades quietly when it isn't).
export function available() {
  return typeof indexedDB !== 'undefined';
}

export async function putAsset(rec) {
  if (cloud()) return putAssetCloud(rec);
  const { store, done } = await tx('readwrite');
  store.put(rec);
  await done;
  return rec.id;
}

export async function getAsset(id) {
  if (cloud()) return getAssetCloud(id);
  const { store } = await tx('readonly');
  return wrap(store.get(id)).then((r) => r || null);
}

// Newest first — the order the Library shows them in.
export async function listAssets() {
  if (cloud()) return listAssetsCloud();
  const { store } = await tx('readonly');
  const all = await wrap(store.getAll());
  return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function deleteAsset(id) {
  if (cloud()) return deleteAssetCloud(id);
  const { store, done } = await tx('readwrite');
  store.delete(id);
  await done;
}

export async function clearAssets() {
  if (cloud()) return clearAssetsCloud();
  const { store, done } = await tx('readwrite');
  store.clear();
  await done;
}

export async function countAssets() {
  if (cloud()) return countAssetsCloud();
  const { store } = await tx('readonly');
  return wrap(store.count());
}
