// merge.js — fold a prior POC into a Core application at the GOVERNANCE + CAPABILITY +
// LINEAGE level (NOT literal source-code fusion into one runnable program).
//
// [INVENTION] Two mechanisms here are the crux of the contribution:
//
//  (b) GOVERNANCE DELTA — on absorption we re-derive the regulatory triage on the MERGED
//      corpus and report the exact, evidence-linked change: does absorbing this POC move
//      the Core's Lane/tier, and WHICH incoming policy signal at WHICH file:line caused it.
//      It reuses the engine's own pure re-resolver (the same approach `lighten` uses) so
//      the answer is deterministic, not a model's opinion.
//
//  (c) REPRODUCIBLE LINEAGE — every file in the merged corpus is tagged with the POC it
//      came from (an origin path prefix), so a §-condition's evidence row inherently
//      carries its source ("incoming-poc/src/api.js:42"). The union dedupes byte-identical
//      files while RECORDING both origins, so provenance is never lost to dedup.
//
// Combined with overlap.js's explainable, policy-signal overlap (a) and hash.js's
// reproducibility, this triple is the thing worth documenting. See docs/INVENTION_DISCLOSURE.md.

import { scanCorpus, stripComments } from './scan.js';
import { hashString } from './hash.js';
import { computeOverlap } from './overlap.js';

// Filesystem-safe origin tag for a POC, used as the path prefix that carries lineage.
export function slugify(s) {
  return String(s || 'poc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'poc';
}

// The origin POC tag of a merged-corpus file path (the first path segment).
export function pocTagOf(path) {
  const i = String(path || '').indexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

// Return a copy of a corpus with every file path prefixed by `tag/`, so its files carry
// their provenance in the path. Idempotent guard: files already under `tag/` are left as-is.
export function tagCorpus(corpus, tag) {
  const t = slugify(tag);
  const files = ((corpus && corpus.files) || []).map((f) => ({
    ...f,
    path: f.path && f.path.startsWith(t + '/') ? f.path : `${t}/${f.path}`,
  }));
  return { source: (corpus && corpus.source) || 'upload', label: (corpus && corpus.label) || 'POC', files, meta: (corpus && corpus.meta) || {}, notes: (corpus && corpus.notes) || [] };
}

// Comment/string-aware normalized content key — two files that differ only in comments
// or whitespace dedupe to the same key (reuses the scanner's stripComments).
function contentKey(file) {
  return hashString(String(stripComments(file.path, file.text || '') || '').toLowerCase().replace(/\s+/g, ' ').trim());
}

/**
 * [INVENTION] mergeCorpora — union a Core corpus with an incoming POC's corpus, preserving
 * lineage. The Core corpus is assumed already origin-tagged (createCore / prior merges);
 * the incoming corpus is tagged with `incomingTag`. Byte-identical files (modulo
 * comments/whitespace) are deduped when `dedupe`, RECORDING both origins.
 *
 * @returns { mergedCorpus, provenance:[{path, fromPOC, deduped?, alsoInPath?}], overlap,
 *            contributed:{ files:[path], signals:[signalId] } }
 *          mergedCorpus is a NORMAL corpus — extractFacts/resolve run on it unchanged.
 */
export function mergeCorpora(coreCorpus, incomingCorpus, { dedupe = true, incomingTag } = {}) {
  const tag = slugify(incomingTag || (incomingCorpus && incomingCorpus.label) || 'incoming');
  const tagged = tagCorpus(incomingCorpus, tag);
  const coreFiles = (coreCorpus && coreCorpus.files) || [];

  // Map every existing Core file by its normalized content key, so an incoming duplicate
  // can be folded in without a second copy (but with its origin still on record).
  const coreByKey = new Map();
  for (const f of coreFiles) { const k = contentKey(f); if (!coreByKey.has(k)) coreByKey.set(k, f.path); }

  const provenance = coreFiles.map((f) => ({ path: f.path, fromPOC: pocTagOf(f.path) }));
  const keptIncoming = [];
  for (const f of tagged.files) {
    const k = contentKey(f);
    const dupOf = coreByKey.get(k);
    if (dedupe && dupOf) {
      provenance.push({ path: f.path, fromPOC: tag, deduped: true, alsoInPath: dupOf });
    } else {
      keptIncoming.push(f);
      provenance.push({ path: f.path, fromPOC: tag });
    }
  }

  const mergedCorpus = {
    source: 'merged',
    label: (coreCorpus && coreCorpus.label) || 'Core',
    files: [...coreFiles, ...keptIncoming],
    meta: { ...(coreCorpus && coreCorpus.meta) },
    notes: [],
  };

  // Explainable overlap (core vs the tagged incoming) — provenance paths carry origins.
  const overlap = computeOverlap(coreCorpus, tagged);
  // Signals the incoming POC adds that the Core didn't already have (inB && !inA).
  const newSignals = overlap.signalOverlap.perSignal.filter((p) => p.inB && !p.inA).map((p) => p.id);

  return {
    mergedCorpus,
    provenance,
    overlap,
    contributed: { files: keptIncoming.map((f) => f.path), signals: newSignals },
  };
}

// Map an evidence row (path+line) back to the policy signal that produced it, by scanning
// the merged corpus. Deterministic (SIGNALS order). Returns null if none matches.
function signalForEvidence(scan, ev) {
  if (!scan || !ev) return null;
  for (const id of Object.keys(scan.signals)) {
    const rows = scan.signals[id].evidence || [];
    if (rows.some((r) => r.path === ev.path && r.line === ev.line)) return id;
  }
  return null;
}

/**
 * [INVENTION] governanceDelta — compare the regulatory triage BEFORE vs AFTER absorbing a
 * POC and report the exact, evidence-linked governance change. `afterScan` (optional, the
 * scanCorpus() of the merged corpus) enriches each cause with the precise policy signalId.
 *
 * @returns { before:{verdict,tier}, after:{verdict,tier}, changed,
 *            causes:[{ conditionId, ref, laneTag, signalId, evidence:{path,line,text}, fromPOC }] }
 *   e.g. "absorbing B moves Core Lane 1 -> Lane 2 because it introduces a §5.5 direct AI
 *         call at incoming-poc/src/api.js:42."
 */
export function governanceDelta(beforeResolve, afterResolve, afterScan = null) {
  const before = { verdict: beforeResolve.verdict.key, tier: beforeResolve.tier };
  const after = { verdict: afterResolve.verdict.key, tier: afterResolve.tier };
  const changed = before.verdict !== after.verdict || before.tier !== after.tier;

  const beforeById = Object.fromEntries(beforeResolve.conditions.map((c) => [c.id, c]));
  const causes = [];
  for (const c of afterResolve.conditions) {
    if (c.status === 'pass') continue;            // a passing condition isn't a cause
    const prior = beforeById[c.id];
    // A cause = a condition that NOW drives the (heavier) read but didn't before — either
    // it was passing before, or it wasn't a driver. This isolates what the merge introduced.
    const newlyDriving = c.driving && (!prior || prior.status === 'pass' || !prior.driving);
    if (!newlyDriving) continue;
    const ev = (c.evidence && c.evidence[0]) || null;
    causes.push({
      conditionId: c.id,
      ref: c.ref,
      laneTag: c.laneTag,
      signalId: signalForEvidence(afterScan, ev),
      evidence: ev,
      fromPOC: ev ? pocTagOf(ev.path) : null,
    });
  }
  return { before, after, changed, causes };
}
