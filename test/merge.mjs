// merge.mjs — tests for the governance-aware, deterministic, evidence-preserving merge:
// overlap.js (explainable overlap), merge.js (mergeCorpora + governanceDelta), core.js
// (manifest + ledger). Run: node test/merge.mjs
//
// These lock in the INVENTION's three properties: (a) explainable overlap over the policy
// signal set + code surface + governed function; (b) automatic re-resolution of the
// regulatory triage producing an evidence-linked Lane/tier delta; (c) reproducible,
// byte-identical lineage. A dedicated determinism test asserts (c) directly.

import { computeOverlap } from '../src/engine/overlap.js';
import { mergeCorpora, governanceDelta, tagCorpus } from '../src/engine/merge.js';
import { createCore, mergeIntoCore, previewMerge, exportAudit } from '../src/engine/core.js';
import { resolve, extractFacts } from '../src/engine/classify.js';
import { scanCorpus } from '../src/engine/scan.js';
import { stableStringify } from '../src/engine/hash.js';
import { benignA, benignB, benignAReformatted, aiPoc, poc } from './fixtures/merge-fixtures.mjs';

const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } };

// A "partial overlap" corpus: the union of benignA + aiPoc files (shares the AI file/signal
// with aiPoc, but also carries the benign file aiPoc lacks).
const unionCorpus = { source: 'upload', label: 'union', files: [...benignA.files, ...aiPoc.files], meta: {}, notes: [] };

console.log(`${B}computeOverlap — explainable signal/file/functional overlap${X}`);
{
  const full = computeOverlap(aiPoc, aiPoc);
  ok('full: identical AI POCs score high', full.similarity.score >= 0.8);
  ok('full: signal Jaccard = 1', full.signalOverlap.jaccard === 1);
  ok('full: shares >=1 fired signal', full.signalOverlap.sharedCount >= 1);
  ok('full: one exact file pair (sim 1)', full.fileOverlap.pairs.length === 1 && full.fileOverlap.pairs[0].kind === 'exact' && full.fileOverlap.pairs[0].similarity === 1);
  ok('full: same capability pattern', full.functionalOverlap.samePattern === true);
  ok('full: components are exposed (no black box)', typeof full.similarity.components.signalJaccard === 'number' && typeof full.similarity.components.fileJaccard === 'number' && typeof full.similarity.components.functional === 'number');

  const disjoint = computeOverlap(benignA, aiPoc);
  ok('disjoint: no shared signals', disjoint.signalOverlap.sharedCount === 0);
  ok('disjoint: no shared files', disjoint.fileOverlap.pairs.length === 0);
  ok('disjoint: low similarity', disjoint.similarity.score < 0.2);

  const partial = computeOverlap(unionCorpus, aiPoc);
  ok('partial: shares >=1 signal', partial.signalOverlap.sharedCount >= 1);
  ok('partial: shares >=1 file', partial.fileOverlap.pairs.length >= 1);
  ok('partial: 0 < score < 1', partial.similarity.score > 0 && partial.similarity.score < 1);
  const sharedSig = partial.signalOverlap.perSignal.find((s) => s.both);
  ok('partial: shared signal carries evidence on BOTH sides', !!sharedSig && !!sharedSig.evidenceA && !!sharedSig.evidenceB);
}

console.log(`${B}mergeCorpora — union with provenance + dedupe${X}`);
{
  const m = mergeCorpora(benignA, aiPoc, { dedupe: true, incomingTag: 'ai' });
  ok('union keeps both files', m.mergedCorpus.files.length === 2);
  ok('incoming file is origin-tagged', m.mergedCorpus.files.some((f) => f.path === 'ai/src/api.js'));
  ok('mergedCorpus is a normal corpus (resolves)', resolve(extractFacts(m.mergedCorpus)).verdict.key === 'lane2');
  ok('provenance records the incoming origin', m.provenance.some((p) => p.path === 'ai/src/api.js' && p.fromPOC === 'ai'));
  ok('contributed.files lists the incoming file', m.contributed.files.includes('ai/src/api.js'));
  ok('contributed.signals lists the §5.5 signal', m.contributed.signals.includes('runtime-ai-direct-vendor-host'));

  const core = tagCorpus(benignA, 'core');
  const dd = mergeCorpora(core, benignAReformatted, { dedupe: true, incomingTag: 'v2' });
  ok('dedupe: a near-duplicate file is NOT re-added', dd.mergedCorpus.files.length === 1);
  ok('dedupe: both origins recorded (deduped + alsoInPath)', dd.provenance.some((p) => p.deduped && p.alsoInPath === 'core/index.html'));
  const noDd = mergeCorpora(core, benignAReformatted, { dedupe: false, incomingTag: 'v2' });
  ok('no-dedupe: the file IS added (namespaced)', noDd.mergedCorpus.files.length === 2);
}

console.log(`${B}governanceDelta — evidence-linked Lane/tier change on absorption${X}`);
{
  const core = createCore('Core', poc(benignA), { at: 1000 });
  ok('Core seeds at Lane 1', core.currentVerdictSnapshot.verdict === 'lane1');

  const esc = mergeIntoCore(core, poc(aiPoc), { at: 2000 });
  const d = esc.preview.governanceDelta;
  ok('escalation: governance changed', d.changed === true);
  ok('escalation: Lane 1 -> Lane 2', d.before.verdict === 'lane1' && d.after.verdict === 'lane2');
  const cause = d.causes.find((c) => c.conditionId === 'c55');
  ok('escalation: §5.5 is the driving cause', !!cause);
  ok('escalation: cause names the §5.5 signal', cause && cause.signalId === 'runtime-ai-direct-vendor-host');
  ok('escalation: evidence is the incoming file:line', cause && cause.evidence && cause.evidence.path === 'ai-helper/src/api.js' && cause.evidence.line === 2);
  ok('escalation: evidence text is the direct AI call', cause && /api\.openai\.com/.test(cause.evidence.text));
  ok('escalation: fromPOC is the absorbed POC', cause && cause.fromPOC === 'ai-helper');

  const benign2 = mergeIntoCore(core, poc(benignB), { at: 3000 });
  ok('no-change: two benign POCs do not move the read', benign2.preview.governanceDelta.changed === false);
  ok('no-change: no causes', benign2.preview.governanceDelta.causes.length === 0);
}

console.log(`${B}core manifest + append-only ledger${X}`);
{
  const core = createCore('Pricing tools', poc(benignA), { at: 1000 });
  ok('create: one constituent', core.constituents.length === 1);
  ok('create: content hash present', typeof core.contentHash === 'string' && core.contentHash.length > 0);
  ok('create: founding ledger entry', core.ledger.length === 1 && core.ledger[0].event === 'create' && core.ledger[0].resultHash === core.contentHash);

  const merged = mergeIntoCore(core, poc(aiPoc), { at: 2000 });
  ok('merge: two constituents', merged.manifest.constituents.length === 2);
  ok('merge: snapshot is now Lane 2', merged.manifest.currentVerdictSnapshot.verdict === 'lane2');
  ok('merge: ledger appended (create + merge)', merged.manifest.ledger.length === 2 && merged.manifest.ledger[1].event === 'merge');
  ok('merge: ledger entry records the governance delta', merged.manifest.ledger[1].governanceDelta.changed === true);
  ok('merge: ledger resultHash == manifest hash', merged.manifest.ledger[1].resultHash === merged.manifest.contentHash);
  ok('merge: constituent records contributed signals', merged.manifest.constituents[1].contributedSignals.includes('runtime-ai-direct-vendor-host'));

  const audit = exportAudit(merged.manifest);
  ok('audit: export shape', audit.kind === 'lane.core.audit/v1' && audit.constituents.length === 2 && audit.ledger.length === 2);
}

console.log(`${B}DETERMINISM — identical inputs => byte-identical reports${X}`);
{
  const o1 = stableStringify(computeOverlap(unionCorpus, aiPoc));
  const o2 = stableStringify(computeOverlap(unionCorpus, aiPoc));
  ok('overlap report is byte-identical across runs', o1 === o2);

  const core = createCore('Core', poc(benignA), { at: 1000 });
  const m1 = mergeIntoCore(core, poc(aiPoc), { at: 2000 });
  const m2 = mergeIntoCore(core, poc(aiPoc), { at: 2000 });
  ok('merged manifest hash is reproducible', m1.manifest.contentHash === m2.manifest.contentHash);
  ok('governance delta is byte-identical', stableStringify(m1.preview.governanceDelta) === stableStringify(m2.preview.governanceDelta));
  ok('previewMerge == the committed preview (what you confirm is what you get)', stableStringify(previewMerge(core, poc(aiPoc)).governanceDelta) === stableStringify(m1.preview.governanceDelta));
}

console.log('');
if (fail === 0) console.log(`${G}merge/overlap/core suite: ${pass}/${pass} passed${X}`);
else console.log(`${R}merge/overlap/core suite: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
