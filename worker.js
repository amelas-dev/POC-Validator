// worker.js — Cloudflare Worker entry for the Workers + Static Assets deploy.
//
// Cloudflare's Git build runs `npx wrangler deploy`, which deploys a WORKER (not a
// classic Pages project). This Worker serves the static front-end from the [assets]
// binding and routes the two API paths to the SAME handlers used by the Pages
// Functions in ./functions — so the validated request/response logic is shared, not
// duplicated. (If this is ever deployed as Pages instead, functions/ still works.)
//
// Local `node server.js` + Ollama is a separate dev path and does not use this file.

import { onRequestPost as llmPost } from './functions/api/llm.js';
import { onRequestGet as healthGet } from './functions/api/llm/health.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/llm' && request.method === 'POST') return llmPost({ request, env });
    if (url.pathname === '/api/llm/health' && request.method === 'GET') return healthGet({ request, env });

    // Any other /api/* path: return JSON 404 rather than falling through to assets.
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Everything else: serve the static front-end (index.html, src/, assets/).
    return env.ASSETS.fetch(request);
  },
};
