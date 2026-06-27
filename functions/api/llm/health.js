// functions/api/llm/health.js — Cloudflare Pages Function: GET /api/llm/health
//
// HOSTED counterpart to server.js's Ollama health check. advisor.js's
// checkAvailable() reads:  { ollama, available: { [model]: bool }, models }
// and shows "AI assist" as ready when ollama===true AND available[<model>]===true,
// where <model> is its DEFAULT_MODEL ('gemma4:e4b').
//
// To keep the FRONTEND UNCHANGED across both backends, we report availability under
// that same key. `ollama:true` here means "an AI backend is reachable" — here it's
// Gemma 4 on Cloudflare Workers AI (the env.AI binding). We also send honest
// `provider`/`model` fields the UI uses for display. If the binding is missing we
// report unavailable so the app stays deterministic-only.

// Friendly display name. The actual model is chosen per-call in llm.js (fast primary
// with fallback) and reported back in the /api/llm response, so keep this generic.
const DISPLAY_MODEL = 'Cloudflare Workers AI';

// Keep in sync with DEFAULT_MODEL in src/llm/advisor.js — the key advisor.js looks
// up in `available`. Reporting it true lets the existing UI enable the toggle.
const FRONTEND_MODEL_KEY = 'gemma4:e4b';

export async function onRequestGet(context) {
  const { env } = context;
  const configured = !!(env && env.AI);

  const bodyObj = configured
    ? {
        ok: true,
        ollama: true,                              // "an AI backend is reachable"
        provider: 'cloudflare',
        model: DISPLAY_MODEL,
        models: [FRONTEND_MODEL_KEY],
        available: { [FRONTEND_MODEL_KEY]: true },
      }
    : {
        ok: true,
        ollama: false,
        provider: 'cloudflare',
        model: DISPLAY_MODEL,
        models: [],
        available: {},
      };

  return new Response(JSON.stringify(bodyObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
