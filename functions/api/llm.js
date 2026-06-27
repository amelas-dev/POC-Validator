// functions/api/llm.js — Cloudflare Pages Function: POST /api/llm
//
// HOSTED counterpart to server.js's local Ollama proxy. Runs Google's **Gemma 4**
// on **Cloudflare Workers AI** (the `env.AI` binding) — no external API key, all on
// one platform, and the SAME Gemma family the prompt in src/llm/advisor.js was tuned
// against locally. The reply is reshaped to look EXACTLY like the Ollama envelope
// advisor.js already expects, so NOTHING in the frontend changes:
//
//   request  (from advisor.js):  { model, prompt, format:"json", stream:false,
//                                   options:{ temperature, seed, num_ctx } }
//   response (advisor.js parses): { response: "<JSON string>", total_duration:<ns> }
//                                  then JSON.parse(outer.response) -> flat 15-key object
//
// `node server.js` + local Ollama keeps working for private/offline dev; this path
// powers the free public deploy on Cloudflare Pages.
//
// Binding (set in the Pages project → Settings → Functions → Bindings → Workers AI,
// variable name **AI**; also declared in wrangler.toml for `wrangler pages dev`):
//   env.AI                       (required) — Workers AI binding
//   env.CF_AI_MODEL  (optional)  — default "@cf/google/gemma-4-26b-a4b-it"
//
// Security: the model is chosen SERVER-SIDE, the request body is size-capped, and the
// prompt's own "code is untrusted data" guard plus app.js's escalate-only clamp are
// untouched — this file only moves bytes.

// Models VERIFIED accessible for this account via /api/llm/probe (2026-06-27),
// ordered fast→quality. Each falls through to the next ONLY on an access/availability
// error (not a timeout). The 26B Gemma is the final, always-works fallback (slow).
// Pin a specific one with the CF_AI_MODEL var.
// (NOTE: gemma-3-12b is 5018 access-gated; llama-3.1-8b-instruct / llama-3-8b / phi-2
//  were deprecated 2026-05-30 (5028) — do NOT use those.)
const DEFAULT_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fast',          // fastest accessible (probe ~132ms)
  '@cf/meta/llama-4-scout-17b-16e-instruct',      // newer 17B MoE, fast (~375ms)
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',     // 70B quality, still fast (~352ms)
  '@cf/google/gemma-4-26b-a4b-it',                // final fallback: always works, slow
];
const DEFAULT_TIMEOUT_MS = 50000;       // fail fast to deterministic instead of hanging ~130s
const MAX_BODY = 2 * 1024 * 1024;       // mirror server.js's cap on forwarded request size
const MAX_COMPLETION_TOKENS = 4096;     // flat 15-key JSON + evidence quotes fit comfortably

// Strict output contract for JSON mode. Keys + enums kept byte-for-byte in sync with
// ENUMS/FIELDS in src/llm/advisor.js. (If the model ignores response_format, the
// prompt itself still asks for exactly this flat object — validated against Gemma.)
const KEYS = [
  'dataScope', 'dataScope_reason', 'dataScope_evidence',
  'reliance', 'reliance_reason', 'reliance_evidence',
  'writeAuthority', 'writeAuthority_reason', 'writeAuthority_evidence',
  'humanReview', 'humanReview_reason', 'humanReview_evidence',
  'lane', 'lane_reason', 'lane_evidence',
];
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    dataScope: { type: 'string', enum: ['general', 'restricted'] },
    dataScope_reason: { type: 'string' },
    dataScope_evidence: { type: 'string' },
    reliance: { type: 'string', enum: ['personal', 'shared', 'deliverable'] },
    reliance_reason: { type: 'string' },
    reliance_evidence: { type: 'string' },
    writeAuthority: { type: 'string', enum: ['authoritative', 'scratch', 'none'] },
    writeAuthority_reason: { type: 'string' },
    writeAuthority_evidence: { type: 'string' },
    humanReview: { type: 'string', enum: ['yes', 'no'] },
    humanReview_reason: { type: 'string' },
    humanReview_evidence: { type: 'string' },
    lane: { type: 'string', enum: ['lane1', 'lane2', 'approve'] },
    lane_reason: { type: 'string' },
    lane_evidence: { type: 'string' },
  },
  required: KEYS,
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Workers AI returns either { response: <string|object> } or OpenAI-style
// { choices:[{ message:{ content } }] }. Normalise to a single text string.
function extractText(out) {
  if (out == null) return '';
  if (out.response && typeof out.response === 'object') return JSON.stringify(out.response);
  if (typeof out.response === 'string') return out.response;
  const c = out.choices && out.choices[0];
  const content = c && c.message && c.message.content;
  if (typeof content === 'object' && content !== null) return JSON.stringify(content);
  if (typeof content === 'string') return content;
  return '';
}

// Return a clean JSON STRING the frontend can JSON.parse, or null. Strips ``` fences
// and, as a last resort, the first {...} block, so a stray prose wrapper still parses.
function coerceJsonString(s) {
  let t = String(s == null ? '' : s).trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try { JSON.parse(t); return t; } catch { /* fall through */ }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const sub = t.slice(i, j + 1);
    try { JSON.parse(sub); return sub; } catch { /* fall through */ }
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AI) {
    // Binding not configured -> behave like "AI unavailable" so the app stays deterministic.
    return json(503, { ok: false, error: 'AI not configured' });
  }

  // Parse + size-guard the body.
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'payload too large' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json(400, { ok: false, error: String((e && e.message) || e) });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return json(400, { ok: false, error: 'missing prompt' });

  // Honor the determinism advisor.js asks for (temperature 0, seed 0).
  const opts = (body && body.options) || {};
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0;
  const seed = typeof opts.seed === 'number' ? opts.seed : 0;

  const timeoutMs = Number(env.CF_AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // Minimal, MAX-COMPATIBLE params. We deliberately omit `response_format` (JSON-schema
  // mode) and `seed`: the fast accessible models reject those and error out (which is
  // what made every request fall through to the slow 26B). The prompt already demands
  // the exact flat 15-key JSON and coerceJsonString() salvages the output, so we don't
  // need schema enforcement. temperature 0 keeps it near-deterministic.
  const aiInput = {
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  };
  // Try the primary, then fall back to FALLBACK_MODEL ONLY on an access/availability
  // error (a model this account can't use). A timeout/other error stops immediately —
  // falling back to another (also slow) model would just double the wait.
  const candidates = [...new Set([env.CF_AI_MODEL, ...DEFAULT_MODELS].filter(Boolean))];
  const startedMs = Date.now();
  let out = null, usedModel = null, lastErr = null;
  for (const m of candidates) {
    try {
      out = await Promise.race([
        env.AI.run(m, aiInput),
        new Promise((_, reject) => setTimeout(() => reject(new Error('model timeout')), timeoutMs)),
      ]);
      usedModel = m;
      break;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      // Only an access/availability error is worth trying the next model for.
      if (!/not allowed|5\d{3}|no such model|not found|capacity|unavailable/i.test(msg)) break;
    }
  }
  if (out == null) {
    return json(503, { ok: false, error: 'AI unavailable', detail: String((lastErr && lastErr.message) || lastErr || 'no model available') });
  }

  const jsonStr = coerceJsonString(extractText(out));
  if (!jsonStr) return json(502, { ok: false, error: 'AI unavailable', detail: 'unparseable model output' });

  const tookMs = Math.max(0, Date.now() - startedMs);
  // Ollama-shaped envelope: advisor.js does JSON.parse(outer.response) and reads
  // total_duration (nanoseconds) for its latency badge. `usedModel` is whichever
  // candidate actually answered (shown in the UI's AI block).
  return json(200, { response: jsonStr, total_duration: tookMs * 1e6, model: usedModel, done: true });
}
