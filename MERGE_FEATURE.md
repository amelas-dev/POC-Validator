# Core + Merge — feature guide and disclosure map

This feature lets a user pick one analyzed POC as a **Core application** and **merge** prior
POCs into it — consolidating at the **governance + capability + lineage** level. It is **not**
literal source-code fusion into one runnable program; it unites the corpora with provenance,
re-resolves the compliance verdict on the union, and records an auditable lineage.

## What the user does

1. Analyze POCs as usual (they're saved to the local Library).
2. In the **Library**, pick a POC → **"Set as Core application."**
3. For any other prior POC → **"Merge into Core."**
4. A calm **merge preview** shows three sections before you confirm:
   - **Overlap** — what's already in the Core (shared policy signals + near-duplicate files,
     with `file:line` on both sides).
   - **Governance impact** — "stays Lane 1" or "Lane 1 → Lane 2 because it introduces a §5.5
     direct-AI call at `ai-helper/src/api.js:2`" (the driving condition + evidence).
   - **Lineage** — which source POC contributes which files/signals.
5. **Confirm** → the Core's combined verdict re-renders, a ledger entry is appended, and the
   change is announced. A **Lineage / audit** drawer shows the constituents, the full ledger,
   and **"Export audit record (JSON)."**

## Where it lives (reference implementation)

| Concern | Module | Key export |
|---|---|---|
| Reproducible fingerprints | `src/engine/hash.js` | `hashCorpus`, `hashManifest`, `stableStringify` |
| Explainable overlap | `src/engine/overlap.js` | `computeOverlap(a, b)` |
| Union + governance delta | `src/engine/merge.js` | `mergeCorpora`, `governanceDelta`, `tagCorpus` |
| Core manifest + ledger | `src/engine/core.js` | `createCore`, `previewMerge`, `mergeIntoCore`, `exportAudit` |
| Tests + fixtures | `test/merge.mjs`, `test/fixtures/merge-fixtures.mjs` | 46 assertions incl. determinism |

All four engine modules are pure and deterministic; each is tagged `// [INVENTION]` at the
mechanism it implements.

## Map to the invention disclosure

The disclosure (`docs/INVENTION_DISCLOSURE.md`) claims a **specific combination**, not a broad
idea. The three pillars and where they are realized:

| Disclosure pillar | Realized by | Test |
|---|---|---|
| **(a)** explainable overlap over the policy signal set + code surface + governed function | `overlap.js: computeOverlap` | `computeOverlap — full/partial/disjoint` |
| **(b)** automatic re-resolution → evidence-linked Lane/tier delta (which signal, which file:line, which POC) | `merge.js: governanceDelta`; `core.js: previewMerge/mergeIntoCore` | `governanceDelta — escalation + no-change` |
| **(c)** reproducible, auditable cross-POC lineage (origin-tagged files, dedupe-with-origins, append-only hashed ledger) | `merge.js: mergeCorpora/tagCorpus`; `core.js` manifest + ledger; `hash.js` | `core manifest + ledger`, `DETERMINISM` |

Honest prior-art acknowledgement and the claim elements are in the disclosure §B and §C/§D.

## Invariants

- Zero runtime dependencies, 100% client-side; **no new network egress** (overlap/merge/delta
  are local + deterministic — no model, no embeddings).
- Existing engine API and all pre-existing tests unchanged (1184 checks green; +46 new).
- Calm UX, full keyboard + screen-reader support (`announce()` live region), reduced-motion,
  plain language.

## Status

- ✅ Engine (overlap / merge / governance-delta / core+ledger) + tests + determinism.
- ✅ IP docs (`docs/INVENTION_DISCLOSURE.md`, `docs/DESIGN_DECISIONS.md`, this file).
- ✅ Persistence — Core manifest in a separate local IndexedDB (`src/library/core-store.js`).
- ✅ UI — Library "Set as Core" / "Merge into Core", a Core banner, the three-section merge
  preview (Overlap · Governance impact · Lineage), and a Lineage / audit drawer with
  "Export audit record (JSON)". Reuses the search/diff modal a11y pattern (inert backdrop,
  Esc/restore-focus), `announce()` live region, reduced-motion, plain language.
