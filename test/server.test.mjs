// server.test.mjs — boots the local dev server on an ephemeral port and locks in the hardening:
// the static handler must NOT serve source / .git / secrets / functions (FIX-06), must still
// serve the app, and the /api/llm proxy must enforce the model allowlist and reject bad bodies.
//
//   node test/server.test.mjs
//
// READER_FALLBACK=off keeps the proxy from reaching the hosted reader, so the test makes no
// external network calls (a missing local Ollama degrades straight to 503).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 4318;
const base = `http://127.0.0.1:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } };

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  // OLLAMA_HOST -> a dead port so the local read deterministically fails (independent of whether
  // a real Ollama happens to be running on this machine); fallback off -> graceful 503.
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', READER_FALLBACK: 'off', OLLAMA_HOST: 'http://127.0.0.1:9' },
  stdio: 'ignore',
});

const status = async (path, opts) => { try { return (await fetch(base + path, opts)).status; } catch { return 0; } };
async function waitReady(ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await status('/index.html')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  ok('server boots and serves index.html', await waitReady());

  console.log(`${B}static handler — denylist (FIX-06)${X}`);
  ok('GET /.git/config -> 404', await status('/.git/config') === 404);
  ok('GET /server.js -> 404', await status('/server.js') === 404);
  ok('GET /.dev.vars -> 404', await status('/.dev.vars') === 404);
  ok('GET /package.json -> 404', await status('/package.json') === 404);
  ok('GET /wrangler.toml -> 404', await status('/wrangler.toml') === 404);
  ok('GET /functions/api/llm.js -> 404', await status('/functions/api/llm.js') === 404);
  ok('GET /test/server.test.mjs -> 404', await status('/test/server.test.mjs') === 404);
  // case-insensitive bypass must NOT slip the denylist (macOS/Windows FS are case-insensitive)
  ok('GET /SERVER.JS -> 404 (case bypass)', await status('/SERVER.JS') === 404);
  ok('GET /Server.js -> 404 (case bypass)', await status('/Server.js') === 404);
  ok('GET /FUNCTIONS/api/llm.js -> 404 (case bypass)', await status('/FUNCTIONS/api/llm.js') === 404);
  // supabase schema (RLS/storage policies) and docs are not front-end assets
  ok('GET /supabase/schema.sql -> 404', await status('/supabase/schema.sql') === 404);
  ok('GET /README.md -> 404', await status('/README.md') === 404);

  console.log(`${B}static handler — still serves the app${X}`);
  ok('GET / -> 200', await status('/') === 200);
  ok('GET /index.html -> 200', await status('/index.html') === 200);
  ok('GET /src/app.js -> 200', await status('/src/app.js') === 200);
  ok('GET /src/engine/classify.js -> 200', await status('/src/engine/classify.js') === 200);
  ok('GET /missing.file -> 404', await status('/nope.xyz') === 404);

  console.log(`${B}/api/llm — model allowlist + body guard${X}`);
  const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  ok('disallowed model -> 400', await status('/api/llm', post(JSON.stringify({ model: 'gpt-4o', prompt: 'x' }))) === 400);
  ok('malformed JSON body -> 400', await status('/api/llm', post('this is not json')) === 400);
  ok('GET /api/llm (wrong method) -> 404', await status('/api/llm') === 404);
  // Allowed model with no local Ollama and fallback off -> graceful 503 (not a crash).
  ok('allowed model, no backend -> 503', await status('/api/llm', post(JSON.stringify({ model: 'gemma4:e4b', prompt: 'x' }))) === 503);
} finally {
  child.kill('SIGKILL');
}

console.log('');
if (fail === 0) console.log(`${G}server suite: ${pass}/${pass} passed${X}`);
else console.log(`${R}server suite: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
