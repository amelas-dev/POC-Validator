// advisor.test.mjs — the LLM advisor's safety invariants and the de-escalation clamp.
//
// These guard prompt-injection-relevant behavior on a small, untrusted local model whose
// output feeds the verdict: runAdvisor must NEVER throw, must enum-validate every field, and
// the escalate-only clamp must refuse to make the verdict lighter than the deterministic floor.
//
//   node test/advisor.test.mjs

import { runAdvisor } from '../src/llm/advisor.js';
import { wouldDeEscalate, LANE_RANK } from '../src/llm/clamp.js';
import { extractFacts, resolve } from '../src/engine/classify.js';

const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } };
async function okNoThrow(name, fn) {
  try { const v = await fn(); ok(name, v); } catch (e) { fail++; console.log(`  ${R}✗ ${name} — THREW: ${e && e.message}${X}`); }
}

// A stub for the same-origin /api/llm proxy. `inner` is the flat 15-key object the model would
// return; the proxy wraps it as { response: "<json string>" } (advisor does a two-step parse).
function stubFetch({ inner, rawResponse, okFlag = true, status = 200, reject = false }) {
  globalThis.fetch = async () => {
    if (reject) throw new Error('network down');
    return {
      ok: okFlag, status,
      json: async () => ({ response: rawResponse !== undefined ? rawResponse : JSON.stringify(inner) }),
    };
  };
}
const CODE = { source: 'upload', label: 't', files: [{ path: 'a.js', text: 'function add(a,b){ return a+b }' }], meta: {}, notes: [] };
const validInner = {
  dataScope: 'restricted', dataScope_reason: 'fund', dataScope_evidence: 'nav',
  reliance: 'shared', reliance_reason: 'team', reliance_evidence: '',
  writeAuthority: 'none', writeAuthority_reason: '', writeAuthority_evidence: '',
  humanReview: 'yes', humanReview_reason: '', humanReview_evidence: '',
  lane: 'lane2', lane_reason: 'r', lane_evidence: '',
};

console.log(`${B}advisor.runAdvisor — never throws, validates output${X}`);

await okNoThrow('malformed (non-JSON) model output -> {ok:false}', async () => {
  stubFetch({ rawResponse: 'this is not json at all' });
  const r = await runAdvisor(CODE);
  return r && r.ok === false;
});

await okNoThrow('fetch rejects (network) -> {ok:false}', async () => {
  stubFetch({ reject: true });
  const r = await runAdvisor(CODE);
  return r && r.ok === false;
});

await okNoThrow('non-ok proxy status -> {ok:false}', async () => {
  stubFetch({ inner: validInner, okFlag: false, status: 503 });
  const r = await runAdvisor(CODE);
  return r && r.ok === false;
});

await okNoThrow('out-of-enum fields -> all coerced to null -> {ok:false}', async () => {
  stubFetch({ inner: { dataScope: 'banana', reliance: 'whatever', writeAuthority: 'maybe', humanReview: 'sometimes', lane: 'data_access' } });
  const r = await runAdvisor(CODE);
  return r && r.ok === false;  // nothing validated
});

await okNoThrow('valid output -> {ok:true} with validated suggestions + second opinion', async () => {
  stubFetch({ inner: validInner });
  const r = await runAdvisor(CODE);
  return r && r.ok === true
    && r.suggestions.dataScope && r.suggestions.dataScope.value === 'restricted'
    && r.suggestions.reliance.value === 'shared'
    && r.secondOpinion && r.secondOpinion.value === 'lane2';
});

await okNoThrow('mixed valid/invalid -> keeps valid, drops invalid', async () => {
  stubFetch({ inner: { ...validInner, reliance: 'NONSENSE', humanReview: 'bogus' } });
  const r = await runAdvisor(CODE);
  return r && r.ok === true && r.suggestions.dataScope.value === 'restricted'
    && r.suggestions.reliance === null && r.suggestions.humanReview === null;
});

await okNoThrow('empty corpus -> {ok:false} without calling the model', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await runAdvisor({ source: 'upload', label: 't', files: [], meta: {}, notes: [] });
  return r && r.ok === false && called === false;  // short-circuits on no readable code
});

console.log(`${B}escalate-only clamp (src/llm/clamp.js)${X}`);
ok('LANE_RANK orders lane1 < lane2 < approve', LANE_RANK.lane1 < LANE_RANK.lane2 && LANE_RANK.lane2 < LANE_RANK.approve);
ok('AI approve->lane1 is a de-escalation (held)', wouldDeEscalate('approve', 'lane1') === true);
ok('AI lane2->lane1 is a de-escalation (held)', wouldDeEscalate('lane2', 'lane1') === true);
ok('AI agrees (lane2->lane2) is NOT a de-escalation', wouldDeEscalate('lane2', 'lane2') === false);
ok('AI escalates (lane1->approve) is NOT a de-escalation (applied)', wouldDeEscalate('lane1', 'approve') === false);
ok('unknown keys default safe (no de-escalation)', wouldDeEscalate('lane1', 'bogus') === false);

// Integration: a restricted+silent-batch tool resolves to Approve from code alone; an AI read
// claiming general/personal/reviewed would lighten it — the clamp must classify that as a
// de-escalation so the app holds the deterministic baseline.
const restrictedBundle = extractFacts({
  source: 'upload', label: 't',
  files: [{ path: 'a.js', text: "const fund_nav = parseStatement(pdf); for (const x of glob('*.pdf')) writeFileSync('out.csv', x);" }],
  meta: {}, notes: [],
});
const baseline = resolve(restrictedBundle, {});
const withAi = resolve(restrictedBundle, { dataScope: 'general', reliance: 'personal', humanReview: true });
ok('deterministic baseline on restricted+silent-batch is heavier than lane1', LANE_RANK[baseline.verdict.key] > 0);
ok('AI lighter read IS flagged as a de-escalation (clamp holds baseline)', wouldDeEscalate(baseline.verdict.key, withAi.verdict.key) === true);

console.log('');
if (fail === 0) console.log(`${G}advisor + clamp suite: ${pass}/${pass} passed${X}`);
else console.log(`${R}advisor + clamp suite: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
