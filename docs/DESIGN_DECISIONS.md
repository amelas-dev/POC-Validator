# Design Decisions — Governance-Aware Merge (conception / diligence log)

A dated record of the design choices behind the Core/merge feature, kept as a
contemporaneous conception and due-diligence record (see `INVENTION_DISCLOSURE.md` §G/§H).
Newest first.

## 2026-06-30 — Conception and reduction to practice

**Goal.** Let a user designate one analyzed POC as a *Core* application and fold prior POCs
into it, with a merge that is *governance-aware*, *deterministic*, and *evidence-preserving*
— explicitly avoiding the well-trodden "detect duplicates and merge" prior art.

### Decisions

1. **Overlap is computed over the policy SIGNAL set, not embeddings.** The differentiator is
   that overlap is expressed in the same vocabulary that decides the regulatory Lane (the
   `SIGNALS` in `ruleset.js`, each mapped to a §-section). A Jaccard over *fired* signals is
   directly explainable ("both POCs make a §5.5 direct-AI call") in a way an embedding cosine
   is not. *Rejected:* embedding/LLM similarity — opaque, non-deterministic, needs a network
   call (violates the zero-network invariant) and weakens subject-matter eligibility.

2. **Re-resolve the triage on the merged corpus; report a structured delta.** Rather than
   re-judge, we reuse the engine's pure re-resolver (`resolve`/`decide`, the same primitive
   behind the existing `lighten` "what one change would make it lighter" feature) and diff the
   before/after `{lane, tier}`. The delta's *causes* are derived from the resolved conditions,
   so the answer is computed, not opined. This reuse is deliberate: it inherits the engine's
   tested determinism and keeps the new code small.

3. **Lineage lives in the file path (origin prefix), plus a provenance map.** Tagging each
   merged file `originTag/originalPath` means a §-condition's evidence row *already* carries
   its source ("ai-helper/src/api.js:2") with no extra plumbing through the resolver. The
   merged corpus stays a *normal* corpus, so `extractFacts`/`resolve` run unchanged — a hard
   constraint (don't fork the engine). A separate `provenance[]` additionally records dedup
   ("also in core/index.html"). *Rejected:* threading a parallel origin structure through the
   resolver — it would require changing the engine API and re-touching the 1184-check suite.

4. **Dedupe is comment/string-aware and records both origins.** Files that differ only in
   comments/whitespace dedupe to one copy (reusing the scanner's `stripComments`), but the
   discarded origin is *kept in the ledger/provenance* — survivorship without provenance loss.

5. **Determinism is a tested property, not an aspiration.** No `Date.now`/`Math.random` in the
   engine; content-based hashing (`hash.js`); stable key-sorted serialization; scores rounded
   to 4 decimals. `test/merge.mjs` asserts byte-identical overlap reports and reproducible
   manifest hashes, and that `previewMerge` equals the committed result. This underpins the
   audit ledger and the eligibility argument.

6. **Append-only ledger with reproducible hashes.** Each merge appends `{ at, sourcePoc,
   overlapSummary, governanceDelta, assumptions, resultHash }`. `resultHash = hashManifest`,
   which hashes only content-bearing fields (constituents + corpus + verdict), *excluding* the
   ledger itself and human timestamps — so it is reproducible and non-circular. The ledger is
   the audit + conception evidence vehicle.

7. **Persistence: full corpora in IndexedDB (already), Core manifest in a separate local DB.**
   The Library already stores full corpora (file bytes) in IndexedDB (`library/store.js`);
   re-opening a saved check restores it without re-running. The Core manifest (which embeds the
   merged corpus) is too large for localStorage, so it lives in IndexedDB as well. Local-only,
   namespaced `lane.*`, no new network egress.

8. **Scope boundary held.** "Merge" = consolidation at the governance + capability + lineage
   level (unite corpora, re-resolve the verdict, track contribution). It is **not** literal
   source-code fusion into one runnable program. Documented in code and in `MERGE_FEATURE.md`.

### Invariants preserved

- Zero runtime dependencies; 100% client-side; the only outbound call remains GitHub fetch.
- Existing engine API and all pre-existing tests unchanged (1184 checks still green; +46 new).
- Calm single-card UX, keyboard + screen-reader support, reduced-motion, plain language.
