// core.js — the CORE APPLICATION model: a designated base POC that other prior POCs are
// folded into, with a reproducible lineage and an append-only audit ledger.
//
// [INVENTION] This ties the three mechanisms together into an auditable artifact:
//   - a Core manifest whose content hash (hash.js) makes the whole Core reproducible;
//   - constituents that record which source POC contributed which files + policy signals;
//   - an append-only LEDGER where each merge records its overlap summary, the governance
//     delta (the evidence-linked Lane/tier change), the assumptions in effect, and the
//     resulting deterministic hash — so any entry can be independently re-derived.
//
// Pure module: every function takes data and returns data (no IndexedDB, no clock except a
// caller-supplied `at`). Persistence + UI glue live in the app / library layer. Keeping it
// pure is what makes the determinism testable (see test/merge.mjs).

import { extractFacts, resolve } from './classify.js';
import { scanCorpus } from './scan.js';
import { mergeCorpora, governanceDelta, slugify, tagCorpus } from './merge.js';
import { hashCorpus, hashManifest } from './hash.js';

const pocSlug = (poc) => slugify((poc && (poc.tag || poc.label || poc.id)) || 'poc');

function snapshot(resolved, at) {
  return { verdict: resolved.verdict.key, tier: resolved.tier, lane: resolved.verdict.lane, pattern: resolved.pattern, at: at || null };
}

/**
 * createCore — designate a single analyzed POC as the foundation. Its corpus is
 * origin-tagged (so lineage starts immediately) and re-resolved to seed the snapshot.
 *
 * @param {object} poc  { id, label, source, corpus }
 * @returns Core manifest { id, name, createdAt, constituents[], mergedCorpus, currentVerdictSnapshot, ledger[], contentHash }
 */
export function createCore(name, poc, { id, at } = {}) {
  const tag = pocSlug(poc);
  const mergedCorpus = tagCorpus(poc.corpus, tag);
  const resolved = resolve(extractFacts(mergedCorpus));
  const firedSignals = (() => {
    const scan = scanCorpus(mergedCorpus);
    return Object.keys(scan.signals).filter((k) => scan.signals[k].firedRuntime);
  })();
  const manifest = {
    id: id || `core-${tag}`,
    name: name || poc.label || 'Core application',
    createdAt: at || null,
    constituents: [{
      pocId: poc.id, tag, label: poc.label || 'POC', source: poc.source || 'upload',
      contentHash: hashCorpus(poc.corpus), addedAt: at || null,
      contributedSignals: firedSignals, contributedFiles: (poc.corpus.files || []).map((f) => `${tag}/${f.path}`),
    }],
    mergedCorpus,
    currentVerdictSnapshot: snapshot(resolved, at),
    ledger: [{
      at: at || null, event: 'create', sourcePoc: { id: poc.id, label: poc.label, source: poc.source },
      overlapSummary: null, governanceDelta: null, assumptions: {}, resultHash: null,
    }],
    contentHash: null,
  };
  manifest.contentHash = hashManifest(manifest);
  manifest.ledger[0].resultHash = manifest.contentHash;
  return manifest;
}

/**
 * [INVENTION] previewMerge — compute (but DON'T commit) the full governance-aware preview
 * of folding `incomingPoc` into the Core: explainable overlap, the evidence-linked
 * governance delta, the resulting lineage/provenance, and the before/after snapshots.
 * Pure + deterministic, so the preview the user confirms IS exactly what gets committed.
 */
export function previewMerge(manifest, incomingPoc, { dedupe = true, assumptions = {} } = {}) {
  const before = resolve(extractFacts(manifest.mergedCorpus), assumptions);
  const merge = mergeCorpora(manifest.mergedCorpus, incomingPoc.corpus, { dedupe, incomingTag: pocSlug(incomingPoc) });
  const afterScan = scanCorpus(merge.mergedCorpus);
  const after = resolve(extractFacts(merge.mergedCorpus), assumptions);
  const delta = governanceDelta(before, after, afterScan);
  return {
    overlap: merge.overlap,
    governanceDelta: delta,
    provenance: merge.provenance,
    contributed: merge.contributed,
    mergedCorpus: merge.mergedCorpus,
    before: snapshot(before),
    after: snapshot(after),
  };
}

/**
 * mergeIntoCore — commit a merge: append the incoming POC as a constituent, update the
 * merged corpus + verdict snapshot, and append one append-only ledger entry recording the
 * overlap summary, governance delta, assumptions, and the resulting reproducible hash.
 *
 * @returns { manifest: <new manifest>, preview, ledgerEntry }
 */
export function mergeIntoCore(manifest, incomingPoc, { dedupe = true, assumptions = {}, at } = {}) {
  const preview = previewMerge(manifest, incomingPoc, { dedupe, assumptions });
  const tag = pocSlug(incomingPoc);
  const next = {
    ...manifest,
    mergedCorpus: preview.mergedCorpus,
    constituents: [...manifest.constituents, {
      pocId: incomingPoc.id, tag, label: incomingPoc.label || 'POC', source: incomingPoc.source || 'upload',
      contentHash: hashCorpus(incomingPoc.corpus), addedAt: at || null,
      contributedSignals: preview.contributed.signals, contributedFiles: preview.contributed.files,
    }],
    currentVerdictSnapshot: { ...preview.after, at: at || null },
    ledger: manifest.ledger.slice(),
  };
  const resultHash = hashManifest(next);   // hashManifest ignores ledger/timestamps -> no circularity
  next.contentHash = resultHash;
  const ledgerEntry = {
    at: at || null, event: 'merge',
    sourcePoc: { id: incomingPoc.id, label: incomingPoc.label, source: incomingPoc.source },
    overlapSummary: {
      similarity: preview.overlap.similarity.score,
      sharedSignals: preview.overlap.signalOverlap.sharedCount,
      nearDuplicateFiles: preview.overlap.fileOverlap.pairs.length,
    },
    governanceDelta: preview.governanceDelta,
    assumptions,
    resultHash,
  };
  next.ledger.push(ledgerEntry);
  return { manifest: next, preview, ledgerEntry };
}

// A counsel-/auditor-facing JSON export of the Core's reproducible lineage + ledger.
export function exportAudit(manifest) {
  return {
    kind: 'lane.core.audit/v1',
    core: { id: manifest.id, name: manifest.name, createdAt: manifest.createdAt, contentHash: manifest.contentHash },
    currentVerdict: manifest.currentVerdictSnapshot,
    constituents: manifest.constituents.map((c) => ({
      pocId: c.pocId, label: c.label, source: c.source, contentHash: c.contentHash, addedAt: c.addedAt,
      contributedSignals: c.contributedSignals, contributedFileCount: (c.contributedFiles || []).length,
    })),
    ledger: manifest.ledger,
    corpusHash: hashCorpus(manifest.mergedCorpus),
  };
}
