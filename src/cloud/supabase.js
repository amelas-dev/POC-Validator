// cloud/supabase.js — Lane's optional cloud layer.
//
// Lane is local-first: with no account it runs entirely on-device (localStorage +
// IndexedDB) exactly as before. Sign in and the same data — your check history and
// your saved files — syncs to your private Supabase account instead, walled off to
// you by Row-Level Security (see supabase/schema.sql).
//
// The Supabase client is loaded lazily from an ESM CDN, so there's no build step
// and nothing is fetched until cloud is both configured AND first used.

import { SUPABASE_URL, SUPABASE_ANON_KEY, CLOUD_ENABLED } from './config.js';

const CHECKS_TABLE = 'checks';
const ASSETS_TABLE = 'library_assets';
const BUCKET = 'lane-library';

let _createClient = null;
let _client = null;
let _user = null;            // cached signed-in user (null = signed out)
const _authSubs = new Set(); // listeners notified on (user) when auth changes

export function cloudConfigured() { return CLOUD_ENABLED; }

// Lazily pull in supabase-js (only when cloud is configured and first needed).
async function ensureLib() {
  if (_createClient) return _createClient;
  const mod = await import('https://esm.sh/@supabase/supabase-js@2');
  _createClient = mod.createClient;
  return _createClient;
}

// The shared client. Returns null when cloud isn't configured, so every caller
// can simply `const c = await client(); if (!c) return <local fallback>`.
async function client() {
  if (!CLOUD_ENABLED) return null;
  if (_client) return _client;
  const createClient = await ensureLib();
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  // Keep the cached user fresh and fan out to listeners (sidebar, avatar, settings).
  _client.auth.onAuthStateChange((_evt, session) => {
    _user = session?.user || null;
    _authSubs.forEach((fn) => { try { fn(_user); } catch {} });
  });
  return _client;
}

// ---- auth ------------------------------------------------------------------

// Resolve the current user once at startup (reads the persisted session).
// "Signed in" means there's an actual SESSION — not merely a user object, which
// the server also returns for a confirmation-pending sign-up.
export async function initAuth() {
  const c = await client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  _user = data?.session?.user || null;
  return _user;
}

// Synchronous best-effort read of who's signed in (after initAuth has run).
export function currentUser() { return _user; }
export function isSignedIn() { return !!_user; }

// Subscribe to auth changes; returns an unsubscribe function.
export function onAuth(fn) { _authSubs.add(fn); return () => _authSubs.delete(fn); }

export async function signIn(email, password) {
  const c = await client();
  if (!c) throw new Error('Cloud is not configured.');
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  _user = data.session?.user || null;
  return _user;
}

export async function signUp(email, password) {
  const c = await client();
  if (!c) throw new Error('Cloud is not configured.');
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  // Only a real session counts as signed in. With email confirmation on, the
  // server returns a user but no session — the caller shows a "confirm" notice.
  _user = data.session ? data.session.user : null;
  return { user: data.user, needsConfirm: !data.session };
}

export async function signOut() {
  const c = await client();
  if (!c) return;
  await c.auth.signOut();
  _user = null;
}

// ---- checks (the history / recents record) ---------------------------------

// Newest first. Each row is normalized to the shape the sidebar already renders.
export async function listChecks(limit = 50) {
  const c = await client();
  if (!c || !_user) return [];
  const { data, error } = await c
    .from(CHECKS_TABLE)
    .select('slug, source, verdict, confidence')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function insertCheck(rec) {
  const c = await client();
  if (!c || !_user) return null;
  const row = {
    user_id: _user.id,
    slug: rec.slug,
    source: rec.source,
    verdict: rec.verdict,
    confidence: rec.confidence || 'high',
  };
  const { error } = await c.from(CHECKS_TABLE).insert(row);
  if (error) throw error;
  return true;
}

export async function clearChecks() {
  const c = await client();
  if (!c || !_user) return;
  const { error } = await c.from(CHECKS_TABLE).delete().eq('user_id', _user.id);
  if (error) throw error;
}

// ---- library (file metadata + bytes) ---------------------------------------
// Bytes live in the private Storage bucket under "<uid>/<assetId>/<name>"; the
// row in library_assets points at that path. Signatures mirror library/store.js
// so it can delegate here transparently when the user is signed in.

function assetPath(id, name) {
  const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_');
  return `${_user.id}/${id}/${safe}`;
}

export async function listAssetsCloud() {
  const c = await client();
  if (!c || !_user) return [];
  const { data, error } = await c
    .from(ASSETS_TABLE)
    .select('id, name, content_type, size_bytes, storage_path, verdict, source, file_count, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id, name: r.name, type: r.content_type,
    size: r.size_bytes, storagePath: r.storage_path,
    verdict: r.verdict ?? null, source: r.source ?? null,
    fileCount: r.file_count ?? null,
    createdAt: r.created_at ? Date.parse(r.created_at) : 0,
  }));
}

export async function putAssetCloud(rec) {
  const c = await client();
  if (!c || !_user) throw new Error('Not signed in.');
  const blob = rec.blob || rec.file || rec.data;
  const path = assetPath(rec.id, rec.name);
  const up = await c.storage.from(BUCKET).upload(path, blob, {
    contentType: rec.type || blob?.type || 'application/octet-stream',
    upsert: true,
  });
  if (up.error) throw up.error;
  const { error } = await c.from(ASSETS_TABLE).upsert({
    id: rec.id,
    user_id: _user.id,
    name: rec.name,
    content_type: rec.type || blob?.type || null,
    size_bytes: rec.size ?? blob?.size ?? null,
    storage_path: path,
    verdict: rec.verdict ?? null,
    source: rec.source ?? null,
    file_count: rec.fileCount ?? null,
    created_at: rec.createdAt ? new Date(rec.createdAt).toISOString() : undefined,
  });
  if (error) throw error;
  return rec.id;
}

export async function getAssetCloud(id) {
  const c = await client();
  if (!c || !_user) return null;
  const { data: row, error } = await c
    .from(ASSETS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const dl = await c.storage.from(BUCKET).download(row.storage_path);
  if (dl.error) throw dl.error;
  return {
    id: row.id, name: row.name, type: row.content_type,
    size: row.size_bytes, createdAt: row.created_at ? Date.parse(row.created_at) : 0,
    blob: dl.data,
  };
}

export async function deleteAssetCloud(id) {
  const c = await client();
  if (!c || !_user) return;
  const { data: row } = await c.from(ASSETS_TABLE).select('storage_path').eq('id', id).maybeSingle();
  if (row?.storage_path) await c.storage.from(BUCKET).remove([row.storage_path]);
  await c.from(ASSETS_TABLE).delete().eq('id', id);
}

export async function clearAssetsCloud() {
  const c = await client();
  if (!c || !_user) return;
  const { data: rows } = await c.from(ASSETS_TABLE).select('storage_path').eq('user_id', _user.id);
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length) await c.storage.from(BUCKET).remove(paths);
  await c.from(ASSETS_TABLE).delete().eq('user_id', _user.id);
}

export async function countAssetsCloud() {
  const c = await client();
  if (!c || !_user) return 0;
  const { count, error } = await c
    .from(ASSETS_TABLE).select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}
