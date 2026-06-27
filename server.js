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

// ---- Optional local-AI proxy ------------------------------------------------
// The browser talks only to its own origin; this proxy forwards to a LOCAL
// Ollama daemon so the "AI assist" feature stays on-machine — nothing is ever
// sent to the cloud. It is entirely optional: if Ollama isn't running, the
// app falls back to its deterministic-only behavior.
const OLLAMA = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const ALLOWED_MODELS = new Set(['gemma4:e4b', 'gemma4:26b']);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 120000; // warm-up + rare tail; client retries once
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

// GET /api/llm/health -> is Ollama reachable, and which allowed models are pulled?
async function llmHealth(res) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: ac.signal });
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    const available = {};
    for (const m of ALLOWED_MODELS) available[m] = models.some((n) => n === m || n === m + ':latest');
    sendJson(res, 200, { ok: true, ollama: true, models, available });
  } catch {
    sendJson(res, 200, { ok: true, ollama: false, models: [], available: {} });
  } finally {
    clearTimeout(t);
  }
}

// POST /api/llm -> forward to Ollama. Body: the Ollama request, plus an optional
// `endpoint` ('generate' | 'chat', default 'generate'). We enforce the model
// allowlist and stream:false, and never proxy anywhere but the local daemon.
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
  const endpoint = body.endpoint === 'chat' ? 'chat' : 'generate';
  const { endpoint: _drop, ...rest } = body;
  const payload = { ...rest, stream: false };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);
  try {
    const r = await fetch(`${OLLAMA}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    // Ollama down / timed out — tell the client so it can fall back gracefully.
    sendJson(res, 503, { ok: false, error: 'local AI unavailable', detail: String(e.name === 'AbortError' ? 'timeout' : (e.message || e)) });
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

    // Local-AI proxy routes (handled before static files).
    if (urlPath === '/api/llm/health' && req.method === 'GET') { await llmHealth(res); return; }
    if (urlPath === '/api/llm' && req.method === 'POST') { await llmProxy(req, res); return; }

    if (urlPath === '/') urlPath = '/index.html';

    // Resolve safely under ROOT — block path traversal.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
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

server.listen(PORT, () => {
  console.log(`\n  Lane — POC Validator running at  http://localhost:${PORT}\n`);
});
