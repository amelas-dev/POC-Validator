// Zero-dependency static file server for the Lane POC Validator.
// Serves the app on http://localhost:4173 — no external packages required.
//
//   node server.js            -> serves on port 4173
//   PORT=8080 node server.js  -> serves on port 8080
//
// A local server (rather than opening index.html via file://) is needed so that
// ES modules load and the in-browser GitHub fetch works without file:// CORS limits.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

// ---- Reading engine (model proxy) ------------------------------------------
// Cloud-only: the browser talks only to its own origin, and this proxy forwards
// every read to the hosted Cloudflare Workers AI reader. There is no on-device
// path — the user never has to install, pull, or run a local model.
// Hosted reader (Cloudflare Workers AI). Override with READER_FALLBACK to point
// elsewhere; set READER_FALLBACK=off to disable the reader entirely.
const FALLBACK = (process.env.READER_FALLBACK || 'https://pocai.alexmelas.workers.dev').replace(/\/$/, '');
const FALLBACK_ENABLED = process.env.READER_FALLBACK !== 'off';
const ALLOWED_MODELS = new Set(['gemma4:e4b', 'gemma4:26b']);
const FALLBACK_TIMEOUT_MS = Number(process.env.READER_FALLBACK_TIMEOUT_MS) || 55000;
const LLM_MAX_BODY = 2 * 1024 * 1024; // cap forwarded request size

function readBody(req, limit = LLM_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// GET /api/llm/health -> is the hosted Cloudflare reader answering right now?
// Cloud-only: the read always runs on the hosted reader, so this simply reports
// whether that reader is reachable. `provider` lets the frontend show status.
async function llmHealth(res) {
  const h = FALLBACK_ENABLED ? await fallbackHealth() : null;
  if (h && h.available) sendJson(res, 200, { ok: true, ollama: true, provider: 'cloud', model: h.model, models: [DEFAULT_MODEL_KEY], available: { [DEFAULT_MODEL_KEY]: true } });
  else sendJson(res, 200, { ok: true, ollama: false, provider: null, models: [], available: {} });
}

// The frontend's model key — what `available` is keyed by in both modes.
const DEFAULT_MODEL_KEY = 'gemma4:e4b';

// Best-effort probe of the hosted reader's health (short timeout — never blocks).
async function fallbackHealth() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3500);
  try {
    const r = await fetch(`${FALLBACK}/api/llm/health`, { signal: ac.signal });
    const h = await r.json();
    return { available: !!(h.available && (h.available[DEFAULT_MODEL_KEY] || Object.values(h.available).some(Boolean))), model: h.model || null };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// POST /api/llm -> forward the read to the hosted Cloudflare reader. Enforces the
// model allowlist and stream:false. Cloud-only: there is no local daemon path.
async function llmProxy(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e.message || e) });
    return;
  }
  if (!ALLOWED_MODELS.has(body.model)) {
    sendJson(res, 400, { ok: false, error: `model not allowed: ${body.model}` });
    return;
  }
  const { endpoint: _drop, ...rest } = body;   // `endpoint` was Ollama-only; drop it
  const payload = { ...rest, stream: false };
  if (FALLBACK_ENABLED && await proxyToFallback(payload, res)) return;
  sendJson(res, 503, { ok: false, error: 'reader unavailable' });
}

// Forward the read to the hosted reader. Returns true once it has written a
// response, false if the hosted reader was unreachable.
async function proxyToFallback(payload, res) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FALLBACK_TIMEOUT_MS);
  try {
    const r = await fetch(`${FALLBACK}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: ac.signal,
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // Reader proxy routes (handled before static files).
    if (urlPath === '/api/llm/health' && req.method === 'GET') { await llmHealth(res); return; }
    if (urlPath === '/api/llm' && req.method === 'POST') { await llmProxy(req, res); return; }

    if (urlPath === '/') urlPath = '/index.html';

    // Resolve safely under ROOT — block path traversal.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // Denylist (mirrors .assetsignore): never serve source/config/secrets in dev.
    // Reject any dotfile/dotdir segment, sensitive basenames, or top-level dirs.
    const rel = filePath.slice(ROOT.length).replace(/^[\\/]+/, '');
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    const base = segments[segments.length - 1] || '';
    const DENY_BASENAMES = new Set([
      'server.js', 'package.json', 'package-lock.json',
      'wrangler.toml', 'worker.js', '.assetsignore',
    ]);
    const DENY_TOP_DIRS = new Set(['functions', 'test', 'node_modules']);
    const hasDotSegment = segments.some((s) => s.startsWith('.'));
    if (hasDotSegment || DENY_BASENAMES.has(base) || DENY_TOP_DIRS.has(segments[0])) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
  }
});

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  Lane — POC Validator running at  http://localhost:${PORT}  (bound to ${HOST})\n`);
});
