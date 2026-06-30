// sources.test.mjs — the untrusted-input boundary: GitHub URL parsing, the paste loader, the
// file-list cap/accounting, and the advisor code digest. Pure/near-pure (no network), so these
// lock in the loader fixes (anchored host parsing, .env.* admission, honest truncation notes,
// digest hardening) without a browser.
//
//   node test/sources.test.mjs

import { parseGitHubUrl, loadFromPaste, loadFromFileList, loadFromGitHub } from '../src/engine/sources.js';
import { buildCodeDigest } from '../src/llm/context.js';

const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } };
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

console.log(`${B}parseGitHubUrl — anchored host, tree/blob, ssh, bare${X}`);
eq('https plain', parseGitHubUrl('https://github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
eq('tree/branch/subdir', parseGitHubUrl('https://github.com/o/r/tree/dev/src/app'), { owner: 'o', repo: 'r', branch: 'dev', subdir: 'src/app' });
ok('blob/branch -> branch captured', parseGitHubUrl('https://github.com/o/r/blob/dev/file.js')?.branch === 'dev');
ok('git@ ssh form', parseGitHubUrl('git@github.com:o/r.git')?.owner === 'o');
ok('bare owner/repo', parseGitHubUrl('o/r')?.repo === 'r');
ok('.git suffix stripped', parseGitHubUrl('https://github.com/o/r.git')?.repo === 'r');
ok('look-alike host -> null', parseGitHubUrl('notgithub.com/o/r') === null);
ok('embedded look-alike -> null', parseGitHubUrl('https://evil.com/github.com/o/r') === null);
ok('garbage -> null', parseGitHubUrl('not a url at all !!!') === null);

console.log(`${B}loadFromPaste — language guess + null-safety${X}`);
ok('html guessed', loadFromPaste('<!doctype html><div>x</div>').files[0].path.endsWith('.html'));
ok('python guessed', loadFromPaste('import os\nfrom x import y').files[0].path.endsWith('.py'));
ok('js default', loadFromPaste('const x = 1').files[0].path.endsWith('.js'));
ok('null does not throw, yields one empty file', (() => { const c = loadFromPaste(null); return c.files.length === 1 && c.files[0].text === ''; })());

console.log(`${B}loadFromFileList — caps + honest accounting (FIX-09 / FIX-22)${X}`);
const fakeFile = (path, content) => ({
  name: path.split('/').pop(), webkitRelativePath: path, size: content.length,
  async text() { return content; }, slice(a, b) { return { async text() { return content.slice(a, b); } }; },
});

// 100 small textual files -> MAX_FILES=80 analyzed, 20 attributed to the file-count cap (NOT "non-text").
const many = Array.from({ length: 100 }, (_, i) => fakeFile(`f${i}.js`, `const x${i}=1;`));
const r1 = await loadFromFileList(many);
ok('caps analyzed files at 80', r1.files.length === 80);
ok('note attributes 20 drops to the file-count limit', r1.notes.some((n) => /file-count limit/.test(n)));
ok('does NOT mislabel cap-dropped files as non-text', !r1.notes.some((n) => /20 non-text/.test(n)));

// ~6MB of textual files -> some dropped by the 4MB total budget, surfaced honestly.
const big = Array.from({ length: 30 }, (_, i) => fakeFile(`b${i}.js`, 'x'.repeat(200 * 1024)));
const r2 = await loadFromFileList(big);
ok('drops over-budget files (kept < 30)', r2.files.length < 30);
ok('note surfaces the 4MB total-limit drop', r2.notes.some((n) => /4MB total limit/.test(n)));

// FIX-22: .env.production / Dockerfile.dev are admitted as textual config.
const envList = await loadFromFileList([fakeFile('.env.production', 'API_KEY=sk-x'), fakeFile('Dockerfile.dev', 'FROM node')]);
ok('.env.production is analyzed (not dropped)', envList.files.some((f) => f.path === '.env.production'));
ok('Dockerfile.dev is analyzed', envList.files.some((f) => f.path === 'Dockerfile.dev'));

console.log(`${B}loadFromGitHub — rate-limit detection + raw-CDN bodies${X}`);
// A tiny fetch double: route by URL substring so we can assert which host each
// phase hits and replay GitHub's various 403 shapes.
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const res = (status, { body = '{}', headers = {} } = {}) =>
  new Response(body, { status, headers });
const grab = async (impl) => {
  try { await withFetch(impl, () => loadFromGitHub('o/r', '', () => {})); return { threw: false }; }
  catch (e) { return { threw: true, msg: e.message }; }
};

// SECONDARY (abuse) limit: 403 with Retry-After but NO x-ratelimit-remaining:0 —
// the shape a concurrent burst trips. Must read as a rate limit, NOT "couldn't reach".
const sec = await grab(() => res(403, { body: '{"message":"You have exceeded a secondary rate limit."}', headers: { 'retry-after': '60' } }));
ok('secondary 403 -> rate-limit message', sec.threw && /rate limit/i.test(sec.msg));
// PRIMARY limit: 403 + x-ratelimit-remaining:0.
const prim = await grab(() => res(403, { headers: { 'x-ratelimit-remaining': '0' } }));
ok('primary 403 -> rate-limit message', prim.threw && /rate limit/i.test(prim.msg));
// 429 Too Many Requests with a rate-limit body.
const tooMany = await grab(() => res(429, { body: '{"message":"API rate limit exceeded"}' }));
ok('429 -> rate-limit message', tooMany.threw && /rate limit/i.test(tooMany.msg));
// A non-rate-limit 403 (forbidden) maps to the private/not-found + token hint.
const forbid = await grab(() => res(403, { body: '{"message":"Forbidden"}' }));
ok('plain 403 -> private/not-found hint', forbid.threw && /private|not found/i.test(forbid.msg));
// 404 -> private/not-found.
const missing = await grab(() => res(404));
ok('404 -> private/not-found hint', missing.threw && /private|not found/i.test(missing.msg));

// Token-less (public) file bodies must come from the raw CDN, never the rate-limited
// Contents API — guard against regressing back to per-file API calls.
let hitRawCdn = false, hitContentsApi = false;
await withFetch(async (url) => {
  const u = String(url);
  if (u.includes('/git/trees/')) return res(200, { body: JSON.stringify({ tree: [{ type: 'blob', path: 'app.js', size: 10 }] }) });
  if (u.startsWith('https://api.github.com/repos/o/r/contents/')) { hitContentsApi = true; return res(200, { body: 'const x=1;' }); }
  if (u.startsWith('https://raw.githubusercontent.com/o/r/')) { hitRawCdn = true; return res(200, { body: 'const x=1;' }); }
  if (u === 'https://api.github.com/repos/o/r') return res(200, { body: JSON.stringify({ default_branch: 'main' }) });
  return res(404);
}, () => loadFromGitHub('o/r', '', () => {}));
ok('public file bodies read from raw.githubusercontent.com', hitRawCdn);
ok('public path does NOT call the rate-limited Contents API', !hitContentsApi);

// A rejected token (401) must NOT block a PUBLIC repo. The token field is a password
// input, so a password manager can autofill junk the user never typed → GitHub 401s
// even a public repo. The loader must drop the bad token, retry anonymously, and read
// bodies from the raw CDN.
let sawAuthedMeta = false, sawAnonMeta = false, sawContents401 = false, sawRaw401 = false;
const recovered = await withFetch(async (url, opts) => {
  const u = String(url);
  const authed = !!(opts && opts.headers && opts.headers.Authorization);
  if (u === 'https://api.github.com/repos/o/r') {
    if (authed) { sawAuthedMeta = true; return res(401, { body: '{"message":"Bad credentials"}' }); }
    sawAnonMeta = true; return res(200, { body: JSON.stringify({ default_branch: 'main', private: false }) });
  }
  if (u.includes('/git/trees/')) return res(200, { body: JSON.stringify({ tree: [{ type: 'blob', path: 'app.js', size: 10 }] }) });
  if (u.startsWith('https://api.github.com/repos/o/r/contents/')) { sawContents401 = true; return res(200, { body: 'const x=1;' }); }
  if (u.startsWith('https://raw.githubusercontent.com/o/r/')) { sawRaw401 = true; return res(200, { body: 'const x=1;' }); }
  return res(404);
}, () => loadFromGitHub('o/r', 'ghp_staleBadToken', () => {}));
ok('rejected token: authed meta 401 then anonymous retry', sawAuthedMeta && sawAnonMeta);
ok('rejected token: public bodies still via raw CDN, not Contents API', sawRaw401 && !sawContents401);
ok('rejected token on a public repo still yields files', recovered.files.length === 1);
// The raw 401 message must prompt for a token, never the "couldn't reach" network ghost.
const bad401 = await grab(() => res(401, { body: '{"message":"Bad credentials"}' }));
ok('401 maps to a token message (not a network error)', bad401.threw && /token/i.test(bad401.msg) && !/reach|network|failed|fetch/i.test(bad401.msg));

// A PRIVATE repo with a VALID token routes bodies through the authenticated Contents
// API — the raw CDN can't read a private repo.
let privContents = false, privRaw = false;
await withFetch(async (url) => {
  const u = String(url);
  if (u === 'https://api.github.com/repos/o/r') return res(200, { body: JSON.stringify({ default_branch: 'main', private: true }) });
  if (u.includes('/git/trees/')) return res(200, { body: JSON.stringify({ tree: [{ type: 'blob', path: 'app.js', size: 10 }] }) });
  if (u.startsWith('https://api.github.com/repos/o/r/contents/')) { privContents = true; return res(200, { body: 'secret' }); }
  if (u.startsWith('https://raw.githubusercontent.com/')) { privRaw = true; return res(200, { body: 'secret' }); }
  return res(404);
}, () => loadFromGitHub('o/r', 'ghp_validToken', () => {}));
ok('private repo bodies use the authenticated Contents API (not raw)', privContents && !privRaw);

console.log(`${B}buildCodeDigest — hardened (FIX-16 / FIX-24)${X}`);
ok('file missing path does not throw', (() => { try { buildCodeDigest({ files: [{ text: 'x=1' }] }); return true; } catch { return false; } })());
ok('non-array files does not throw -> empty digest', (() => { try { return buildCodeDigest({ files: {} }).code === '(no readable source files)'; } catch { return false; } })());
ok('single one-line "minified" real file still included (FIX-24 fallback)', (() => {
  const d = buildCodeDigest({ files: [{ path: 'a.js', text: 'a'.repeat(3000) }] });
  return d.manifest.included.length >= 1 && d.code !== '(no readable source files)';
})());

console.log('');
if (fail === 0) console.log(`${G}sources + digest suite: ${pass}/${pass} passed${X}`);
else console.log(`${R}sources + digest suite: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
