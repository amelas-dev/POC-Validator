# Invention Disclosure — Governance-Aware Deterministic POC Merge

> Status: working software disclosure (counsel-ready draft). Prepared for an inventorship
> review and a prior-art search. **It is written to be falsifiable: the claimed novelty is a
> narrow, specific combination, not a broad idea.** Do not file on the broad idea of
> "merging similar things." See §B for what is explicitly NOT claimed.

- **System:** "Lane" (repo: POC-Validator) — a deterministic, client-side governance triage
  tool that classifies a proof-of-concept (POC) into a regulatory hosting Lane (1 / 2 /
  Approve) from the code itself, using a fixed regex SIGNAL set mapped to numbered policy
  sections (§5.x / §6).
- **Feature under disclosure:** designate one analyzed POC as a **Core application**, then
  **merge** prior POCs into it — at the governance + capability + lineage level.
- **Reference implementation:** `src/engine/overlap.js`, `src/engine/merge.js`,
  `src/engine/core.js`, `src/engine/hash.js` (each tagged `// [INVENTION]`), with tests in
  `test/merge.mjs`.

---

## A. Problem

Organizations accumulate many small POCs that overlap or extend one another. To consolidate
them — pick a base and fold others in — a reviewer must answer three questions that existing
tools answer separately, opaquely, or not at all:

1. **What actually overlaps** between two POCs — not just "they look similar," but which
   *governed behaviors* and which *code* are shared, with evidence a non-technical reviewer
   can check.
2. **Whether absorbing a POC changes the compliance posture** of the base — and if so,
   *exactly which incoming thing* (which policy signal, at which file and line) caused the
   change.
3. **Who contributed what**, reproducibly, so the consolidated artifact carries an auditable
   lineage a regulator or auditor can independently re-derive.

In a regulated finance/ops setting the merge decision is a *governance* decision, but the
available tooling treats merge as a *content-similarity* decision.

---

## B. Acknowledged prior art (candid — what is NOT novel)

We do **not** claim, and a prior-art search will (correctly) find, the following:

- **Idea-management merge tools** (e.g. Ideanote, Aha!, IdeaScale): merging duplicate/related
  *ideas* in an innovation backlog. Prior art for "detect related items and combine them."
- **Entity resolution / golden-record / master-data management** and their **survivorship
  rules**: deduplicating records and choosing surviving field values. Heavily patented.
  Prior art for "dedupe with provenance / origin tracking."
- **Duplicate-issue mergers** (e.g. Jira/Atlassian, GitHub issue dedup): linking/merging
  duplicate tickets. Prior art for "merge and keep a back-reference."
- **Semantic code-clone / near-duplicate detection** (token-shingle, AST, and embedding-based
  clone detectors; MOSS-style similarity): finding similar source. Prior art for our *file
  overlap* component **in isolation** — token-shingle Jaccard is textbook.
- **Software composition analysis / SBOM merge** and **policy-as-code** engines (OPA, etc.):
  evaluating a policy over an artifact, and merging dependency manifests. Prior art for
  "evaluate a compliance rule over code" and "union two manifests."

Each individual ingredient above is known. The disclosure rests on a **specific combination**
applied to a specific object (a re-resolvable governance triage), described next.

---

## C. The contribution (the specific, defensible combination)

A method that, when folding a second analyzed artifact (POC B) into a designated base
artifact (the Core), performs **all** of the following as one deterministic, evidence-linked
operation:

1. **Governance-signal overlap.** Computes overlap **over the governance policy's own signal
   set** — the same enumerated regex signals that decide the regulatory Lane — and reports it
   *explainably*: a per-signal table (fires-in-A / fires-in-B / both) and a set-Jaccard, a
   comment/string-aware code-surface overlap, and a *functional* overlap (shared §-conditions
   + capability pattern). No embeddings, no learned model. Every overlap item carries the
   exact `file:line` evidence **in both artifacts**.

2. **Automatic re-resolution → evidence-linked governance delta.** On absorption, **re-runs
   the regulatory triage on the merged corpus** and emits a structured delta: the before/after
   Lane and tier, a `changed` flag, and a list of **causes**, each naming the policy
   *condition* (§-ref), the *signal* that fired, the *evidence row* (`path:line:text`), and
   the *origin POC* that introduced it — e.g. *"absorbing B moves the Core Lane 1 → Lane 2
   because it introduces a §5.5 direct-AI call at `ai-helper/src/api.js:2`."* The re-resolution
   reuses the engine's pure re-resolver (the same mechanism that powers "what one change would
   make it lighter"), so the delta is computed, not judged.

3. **Reproducible, evidence-preserving lineage.** Tags every file in the merged corpus with
   its origin artifact (so a condition's evidence inherently carries provenance), dedupes
   byte-identical files **while recording both origins**, and maintains an **append-only
   ledger** in which each merge event stores its overlap summary, the governance delta, the
   assumptions in effect, and a **deterministic content hash** of the resulting Core — so any
   ledger entry can be independently re-derived from the inputs.

**The novelty is (1)+(2)+(3) together, and their determinism/auditability.** Generic
"merge similar items" stops at (1) and at a similarity score. Tying the overlap to the
*policy signal set*, automatically *re-resolving the regulatory triage* to produce an
*evidence-linked Lane/tier delta*, and binding it to a *reproducible cross-artifact ledger*
is the combination offered as the contribution.

---

## D. Claim elements (independent-claim style) + dependent variations

### Independent (method)

A computer-implemented method for governance-aware consolidation of software artifacts,
comprising:

- **(a)** maintaining a base artifact comprising a corpus of source files, each tagged with
  an origin identifier;
- **(b)** receiving a second artifact comprising a corpus of source files;
- **(c)** computing, deterministically and without a trained model, an overlap report between
  the base and second corpora comprising: (i) a comparison over a fixed set of **policy
  signals**, each policy signal mapped to a section of a governance policy, indicating which
  signals fire in each corpus together with, for each, an evidence location (file and line) in
  each corpus; (ii) a comment- and string-aware content-similarity measure over the files; and
  (iii) a functional comparison based on shared fired policy conditions and a capability
  classification;
- **(d)** forming a merged corpus by uniting the file sets, prefixing each second-artifact
  file with its origin identifier, and, for files whose normalization is identical, retaining
  one copy while recording both origins;
- **(e)** applying a deterministic policy-resolution function to the base corpus and to the
  merged corpus to obtain, respectively, a first and second governance classification each
  comprising a lane and a tier;
- **(f)** generating a governance-delta record indicating whether the classification changed
  and, for each condition that newly drives the changed classification, the policy section,
  the fired policy signal, the evidence location, and the origin identifier of the file that
  caused it; and
- **(g)** appending, to an append-only ledger associated with the base artifact, an entry
  comprising the overlap report summary, the governance-delta record, the resolution
  assumptions in effect, and a deterministic content fingerprint of the merged base, such
  that the entry is independently reproducible from the inputs.

### Dependent variations

- **D1.** Wherein the policy-signal comparison is a Jaccard similarity over the sets of signals
  that fire in runtime-scoped files (excluding documentation/test/build-only matches).
- **D2.** Wherein the content-similarity measure is a Jaccard similarity over fixed-size token
  shingles computed after blanking comments and string literals.
- **D3.** Wherein the overlap report further comprises a single similarity score that is a
  weighted combination of the policy-signal, content, and functional measures, with each
  component value retained in the report.
- **D4.** Wherein the policy-resolution function is re-applied with the same or a varied set of
  user-supplied assumptions, and the governance-delta records the assumption set used.
- **D5.** Wherein generating the governance-delta comprises mapping each evidence location back
  to the policy signal that produced it by scanning the merged corpus.
- **D6.** Wherein the deterministic content fingerprint is computed over a normalized,
  key-sorted serialization of the merged corpus and the artifact's constituents, excluding
  human timestamps and names.
- **D7.** Wherein a merge is previewed by performing (c)–(f) without appending to the ledger,
  and the preview is byte-identical to the committed result.
- **D8.** A system / non-transitory medium performing the method, executing entirely
  client-side with the only outbound request being retrieval of the second artifact's source.
- **D9.** Wherein the governed object is a regulatory hosting-lane triage and the policy
  sections are numbered controls of a hosting/triage playbook.

---

## E. Text flow diagram

```
  Core manifest (base)                 Prior POC B (from local Library)
  ──────────────────                   ────────────────────────────────
  mergedCorpus (origin-tagged)         corpus { source,label,files,meta }
        │                                        │
        │                                        ▼
        │                              tagCorpus(B)  → prefix every path "B/…"  [lineage]
        │                                        │
        ├──────────────┬─────────────────────────┤
        ▼              ▼                          ▼
  resolve(Core)   computeOverlap(Core, taggedB)   mergeCorpora(Core, B, {dedupe})
  = BEFORE        ────────────────────────────    ──────────────────────────────
  {lane,tier}    • signal Jaccard + per-signal     • union files; dedupe byte-identical
                   evidence (A & B)                   (record BOTH origins)
                 • file shingle Jaccard (exact/near) • provenance[]  • contributed{files,signals}
                 • functional (pattern + §-conds)         │
                          │                               ▼
                          │                         mergedCorpus (a NORMAL corpus)
                          │                               │
                          │                               ▼
                          │                         resolve(merged) = AFTER {lane,tier}
                          │                               │
                          └───────────────┬───────────────┘
                                          ▼
                          governanceDelta(BEFORE, AFTER, scan(merged))
                          ───────────────────────────────────────────
                          { before, after, changed,
                            causes:[{conditionId, §ref, signalId,
                                     evidence:{path,line,text}, fromPOC}] }
                                          │
                                          ▼
                          mergeIntoCore  →  new manifest
                          • constituents += {pocId, contentHash, contributedSignals/Files}
                          • currentVerdictSnapshot = AFTER
                          • ledger += { overlapSummary, governanceDelta, assumptions,
                                        resultHash = hashManifest(new) }   [append-only, reproducible]
```

---

## F. Determinism & reproducibility (and why it matters for eligibility)

- **No model, no embeddings, no randomness, no clock in the engine.** Overlap and the
  governance delta are pure functions of the input bytes. Hashing is content-based; sorting is
  stable; floating scores are rounded to fixed precision. Timestamps are supplied by the caller
  and are excluded from the reproducible fingerprint.
- **Independently re-derivable.** `previewMerge()` equals the committed merge byte-for-byte
  (test: "what you confirm is what you get"). Any ledger entry's `resultHash` can be recomputed
  from the constituent corpora. This is asserted directly in `test/merge.mjs` ("DETERMINISM").
- **Why it matters:** a deterministic, rule-grounded transformation that produces a *specific,
  evidence-linked governance artifact* (a Lane/tier delta tied to file:line provenance and an
  auditable ledger) is a concrete technical process with a tangible output — a stronger posture
  than an abstract "compare-and-combine" idea or a black-box similarity score. The reproducible
  audit ledger is also the strongest *evidence vehicle* for the fallback below.

---

## G. If not patentable, protect as…

- **Trade secret / know-how:** the specific signal set, the condition→signal mapping, the
  weighting and thresholds, and the merge/delta procedure can be held as confidential know-how;
  the client-side determinism means the method need not be disclosed to operate.
- **Defensive publication:** publish the determinism + audit-ledger method to prevent others
  from patenting it, if patenting is declined.
- **Copyright + audit-ledger as provenance:** the append-only ledger (with reproducible
  hashes) is itself contemporaneous evidence of authorship, conception dates, and independent
  derivation — useful for both trade-secret enforcement and inventorship disputes. See
  `docs/DESIGN_DECISIONS.md` for the dated conception/diligence record.

---

## H. Inventorship / conception record

- Conception + reduction to practice are recorded as small, dated, descriptive commits (each
  novel module tagged `// [INVENTION]`), and in `docs/DESIGN_DECISIONS.md`.
- The reference implementation is fully tested (`test/merge.mjs`, 46 assertions) and runs with
  zero runtime dependencies, entirely client-side.
