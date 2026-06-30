// overlap.js — DETERMINISTIC, EXPLAINABLE overlap between two analyzed POCs.
//
// [INVENTION] Generic "do these two things look similar / are they duplicates" is
// well-trodden prior art (semantic code-clone detection, entity-resolution / golden
// record, duplicate-issue mergers, idea-merge tools). Those lean on opaque embeddings
// or fuzzy heuristics. The distinctive mechanism here is that overlap is computed over
// the GOVERNANCE POLICY SIGNAL SET (the same regex SIGNALS that decide the regulatory
// Lane), the code surface (comment/string-aware, reusing the scanner's stripComments),
// AND the governed FUNCTION (shared §-conditions + capability pattern) — every component
// is exposed (no black box) and every item carries provenance: the exact file:line in
// POC A and in POC B. Identical inputs produce byte-identical output (see DETERMINISM).
//
//   computeOverlap(corpusA, corpusB) -> {
//     signalOverlap: { jaccard, sharedCount, perSignal:[{id, mapsTo, inA, inB, both, evidenceA, evidenceB}] },
//     fileOverlap:   { score, pairs:[{ aPath, bPath, similarity, kind, aSpan, bSpan }] },
//     functionalOverlap: { samePattern, patternA, patternB, sharedGovernedConditions, jaccard },
//     similarity: { score, components: { signalJaccard, fileJaccard, functional } },
//     meta: { labelA, labelB, hashA, hashB },
//   }

import { scanCorpus } from './scan.js';
import { SIGNALS } from './ruleset.js';
import { extractFacts, resolve } from './classify.js';
import { hashString, hashCorpus } from './hash.js';

const NEAR_DUP_THRESHOLD = 0.6;   // shingle-Jaccard at/above this = "near-duplicate file"
const SHINGLE_K = 3;              // token-window size for the file content shingles

// Round to 4 decimals so a similarity score is BYTE-stable across runs (no trailing
// float drift in the serialized report). Determinism is a deliberate design property.
const r4 = (x) => Math.round((Number.isFinite(x) ? x : 0) * 10000) / 10000;

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// Normalize comment-stripped source for content comparison: lowercase + collapse
// whitespace. Comments/strings are already blanked by the scanner's stripComments, so
// re-formatting and re-commenting the same logic still reads as the same file.
function normalize(stripped) {
  return String(stripped || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tokenize normalized source into words and standalone symbols, then build the set of
// K-token shingles (a deterministic structural fingerprint of the file).
function shingles(normalized) {
  const tokens = normalized.match(/[a-z0-9_$.]+|[^\sa-z0-9_$.]/g) || [];
  const set = new Set();
  if (tokens.length < SHINGLE_K) { tokens.forEach((t) => set.add(t)); return set; }
  for (let i = 0; i + SHINGLE_K <= tokens.length; i++) set.add(tokens.slice(i, i + SHINGLE_K).join(' '));
  return set;
}

function firstEvidence(sig) {
  if (!sig) return null;
  const list = (sig.runtimeEvidence && sig.runtimeEvidence.length) ? sig.runtimeEvidence : sig.evidence;
  const e = list && list[0];
  return e ? { path: e.path, line: e.line, text: e.text } : null;
}

// The set of §-conditions a POC actually trips (status !== pass) under the code-only
// AUTO read — i.e. the governed things it does. Computed with no user assumptions so the
// comparison is deterministic and code-derived.
function governedConditions(corpus) {
  const r = resolve(extractFacts(corpus));
  return new Set(r.conditions.filter((c) => c.status !== 'pass').map((c) => c.id));
}

// [INVENTION] The core overlap computation. See module header.
export function computeOverlap(corpusA, corpusB) {
  const sa = scanCorpus(corpusA);
  const sb = scanCorpus(corpusB);

  // ---- 1) SIGNAL overlap: Jaccard over the fired (lane-relevant) policy-signal sets,
  //         with the evidence row that fired on each side. -------------------------
  const firedA = new Set();
  const firedB = new Set();
  for (const sig of SIGNALS) {
    if (sa.signals[sig.id] && sa.signals[sig.id].firedRuntime) firedA.add(sig.id);
    if (sb.signals[sig.id] && sb.signals[sig.id].firedRuntime) firedB.add(sig.id);
  }
  const perSignal = SIGNALS
    .filter((sig) => firedA.has(sig.id) || firedB.has(sig.id))
    .map((sig) => ({
      id: sig.id,
      mapsTo: sig.mapsTo,
      inA: firedA.has(sig.id),
      inB: firedB.has(sig.id),
      both: firedA.has(sig.id) && firedB.has(sig.id),
      evidenceA: firstEvidence(sa.signals[sig.id]),
      evidenceB: firstEvidence(sb.signals[sig.id]),
    }));
  const signalJaccard = r4(jaccard(firedA, firedB));
  const signalOverlap = { jaccard: signalJaccard, sharedCount: perSignal.filter((p) => p.both).length, perSignal };

  // ---- 2) FILE overlap: comment/string-aware shingle Jaccard, exact + near dupes.
  //         Reuses the scanner's stripped text so comments/strings don't skew it. ---
  const aFiles = sa.files.map((f) => ({ path: f.path, norm: normalize(f.stripped), lineCount: (f.text || '').split('\n').length }));
  const bFiles = sb.files.map((f) => ({ path: f.path, norm: normalize(f.stripped), lineCount: (f.text || '').split('\n').length }));
  aFiles.forEach((f) => { f.exact = hashString(f.norm); f.shingles = shingles(f.norm); });
  bFiles.forEach((f) => { f.exact = hashString(f.norm); f.shingles = shingles(f.norm); });
  const pairs = [];
  for (const a of aFiles.slice().sort((x, y) => (x.path < y.path ? -1 : 1))) {
    let best = null;
    for (const b of bFiles) {
      const sim = a.exact === b.exact ? 1 : r4(jaccard(a.shingles, b.shingles));
      if (sim >= NEAR_DUP_THRESHOLD && (!best || sim > best.sim || (sim === best.sim && b.path < best.b.path))) best = { b, sim };
    }
    if (best) pairs.push({
      aPath: a.path, bPath: best.b.path, similarity: best.sim,
      kind: best.sim === 1 ? 'exact' : 'near',
      aSpan: [1, a.lineCount], bSpan: [1, best.b.lineCount],
    });
  }
  // Dice-style corpus file overlap: matched files on both sides over the total file count.
  const fileScore = r4((2 * pairs.length) / Math.max(1, aFiles.length + bFiles.length));
  const fileOverlap = { score: fileScore, pairs };

  // ---- 3) FUNCTIONAL overlap: same capability pattern + shared governed §-conditions
  //         => "these do the same GOVERNED thing", not just look alike. --------------
  const ba = extractFacts(corpusA);
  const bb = extractFacts(corpusB);
  const govA = governedConditions(corpusA);
  const govB = governedConditions(corpusB);
  const sharedGoverned = [...govA].filter((id) => govB.has(id)).sort();
  const samePattern = !!ba.pattern && ba.pattern === bb.pattern;
  const condJaccard = r4(jaccard(govA, govB));
  const functionalScore = r4((samePattern ? 0.5 : 0) + 0.5 * condJaccard);
  const functionalOverlap = { samePattern, patternA: ba.pattern, patternB: bb.pattern, sharedGovernedConditions: sharedGoverned, jaccard: condJaccard };

  // ---- One similarity score with its components EXPOSED (no black box). -----------
  const score = r4(0.5 * signalJaccard + 0.3 * fileScore + 0.2 * functionalScore);

  return {
    signalOverlap,
    fileOverlap,
    functionalOverlap,
    similarity: { score, components: { signalJaccard, fileJaccard: fileScore, functional: functionalScore } },
    meta: { labelA: (corpusA && corpusA.label) || 'A', labelB: (corpusB && corpusB.label) || 'B', hashA: hashCorpus(corpusA), hashB: hashCorpus(corpusB) },
  };
}
