// functions/api/llm/probe.js — TEMPORARY diagnostic: GET /api/llm/probe
//
// Runs the REAL governance prompt (with enum constraints) against candidate models and
// reports latency + whether the output is parseable AND uses VALID enum values. Lets us
// pick a model that is both fast and accurate. Remove after use.

const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
];

// Correct answer for this code: dataScope=restricted, writeAuthority=authoritative,
// lane=lane2 or approve. A good model nails the enums; a weak one emits junk.
const PROMPT = [
  'You are a software governance classifier. Output ONE flat JSON object and NOTHING else',
  '(no prose, no markdown), with EXACTLY these 15 keys: dataScope, dataScope_reason,',
  'dataScope_evidence, reliance, reliance_reason, reliance_evidence, writeAuthority,',
  'writeAuthority_reason, writeAuthority_evidence, humanReview, humanReview_reason,',
  'humanReview_evidence, lane, lane_reason, lane_evidence.',
  'Use ONLY these exact allowed values:',
  'dataScope = "general" | "restricted"; reliance = "personal" | "shared" | "deliverable";',
  'writeAuthority = "authoritative" | "scratch" | "none"; humanReview = "yes" | "no";',
  'lane = "lane1" | "lane2" | "approve".',
  'CODE:',
  "app.post('/save',(req,res)=>{db.query('UPDATE capital_accounts SET nav=? WHERE id=?',[req.body.nav,req.body.id]);res.json({ok:true})});",
  'Return the flat JSON now.',
].join('\n');

const ENUMS = {
  dataScope: ['general', 'restricted'],
  reliance: ['personal', 'shared', 'deliverable'],
  writeAuthority: ['authoritative', 'scratch', 'none'],
  humanReview: ['yes', 'no'],
  lane: ['lane1', 'lane2', 'approve'],
};

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
function coerceJsonString(s) {
  let t = String(s == null ? '' : s).trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try { JSON.parse(t); return t; } catch {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { const sub = t.slice(i, j + 1); try { JSON.parse(sub); return sub; } catch {} }
  return null;
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.AI) return new Response(JSON.stringify({ ok: false, error: 'no AI binding' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const results = {};
  for (const m of MODELS) {
    const t0 = Date.now();
    try {
      const out = await env.AI.run(m, { messages: [{ role: 'user', content: PROMPT }], temperature: 0, max_completion_tokens: 512 });
      const ms = Date.now() - t0;
      const js = coerceJsonString(extractText(out));
      if (!js) { results[m] = { status: 'UNPARSEABLE', ms, raw: extractText(out).slice(0, 80) }; continue; }
      const a = JSON.parse(js);
      const validFields = Object.keys(ENUMS).filter((k) => typeof a[k] === 'string' && ENUMS[k].includes(a[k].trim().toLowerCase()));
      results[m] = { status: 'OK', ms, validEnums: `${validFields.length}/5`, lane: a.lane, dataScope: a.dataScope, writeAuthority: a.writeAuthority };
    } catch (e) {
      results[m] = { status: 'ERR', error: String((e && e.message) || e).slice(0, 120) };
    }
  }
  return new Response(JSON.stringify({ results }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
