// functions/api/llm/probe.js — TEMPORARY diagnostic: GET /api/llm/probe
//
// Reports Cloudflare's EXACT per-model response so we can see precisely which models
// THIS account can access (OK), which are access-gated (5018), and which are
// unknown/removed ("no such model"). Each call is tiny (8 tokens). Remove after use.

const MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',                 // control: known-good
  '@cf/google/gemma-3-12b-it',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',       // newest Llama — does "v4" track gemma-4 access?
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/qwen/qwq-32b',
  '@cf/microsoft/phi-2',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
];

function extractText(out) {
  if (out == null) return '';
  if (out.response && typeof out.response === 'object') return JSON.stringify(out.response);
  if (typeof out.response === 'string') return out.response;
  const c = out.choices && out.choices[0];
  const content = c && c.message && c.message.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.AI) {
    return new Response(JSON.stringify({ ok: false, error: 'no AI binding' }), {
      status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const results = {};
  for (const m of MODELS) {
    const t0 = Date.now();
    try {
      const out = await env.AI.run(m, {
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_completion_tokens: 8,
        temperature: 0,
      });
      results[m] = { status: 'OK', ms: Date.now() - t0, sample: extractText(out).slice(0, 30) };
    } catch (e) {
      results[m] = { status: 'ERR', error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  return new Response(JSON.stringify({ results }, null, 2), {
    status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
