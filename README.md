# Lane — POC Governance Validator

Drop in a GitHub URL or code files and instantly see which **Lane** a POC is under
the GPFS *Employee-Built Utility Triage & Hosting Playbook* — and exactly **why**.

- **Lane 1 — Host as-is** (Shared Hosting): meets every §5 condition.
- **Lane 2 — Developer-built** (Isolated Hosting): fails any §5 condition.
- **Approve-state → Lane 2** (+ AI Committee sign-off): touches Client/Fund or
  Restricted data, writes to a source of truth, or its output is relied on for a
  client deliverable, reporting, a reconciliation, a control, or compliance.
  *The tier always wins — Approve-state is Lane 2 even as a single static file.*

The verdict is an **automated triage indication** for quick self-assessment, not a
binding gate. The AI Operations Lead makes the hosting decision.

## Run it

```bash
node server.js        # serves http://localhost:4173  (zero dependencies)
```

Then open <http://localhost:4173>. Paste a GitHub URL, drop a folder / `.zip` /
files, or paste a snippet. Everything is analyzed **in your browser** — the only
network call is to GitHub when you give it a repo URL.

## How classification works

A transparent, **deterministic** rules engine (preferred by the policy over
probabilistic judgment) runs the two-step triage:

1. **Risk tier** (`Use` / `Register` / `Approve`) — STAR §3.1.
2. **Lane** — Lane 1 only if *every* §5 condition holds; Lane 2 otherwise.

It scans the code for ~25 signals (direct AI calls vs the approved `/api/chat`
proxy, server runtimes, DB/source-of-truth writes, third-party CDN scripts &
outbound calls, client-side persistence, probabilistic logic, Client/Fund data
keywords, …) and maps each to a §5 condition with the matching `file:line`
evidence.

Facts code **cannot** prove — is the data really Client/Fund? who relies on the
output? is a write target authoritative? — are auto-defaulted, shown as adjustable
assumptions on the relevant condition rows, and the verdict re-resolves instantly
when you correct them.

## The experience

One warm card that morphs in place — no scrolling, no jargon, built for a
non-technical finance/ops person, not an engineer. Paste/drop a tool and the
answer blooms where the input was:

- a glowing status **orb** + a plain headline — **Ready to host** / **Hand it to a
  developer** / **Needs a sign-off first** (calm colours, never red);
- **1–3 reason tiles** in plain language — only what actually decided it;
- a soft *"we assumed it touches client data — change?"* nudge that re-resolves the
  verdict instantly; and
- one obvious next step.

The full eight-check audit — section numbers, `file:line` evidence, risk tier, and
the assumption toggles — lives behind one quiet **"See the full check"** drawer,
off by default. For anything that isn't the light path, it also shows **"what would
make it lighter"** — the one or two changes that would move it toward Lane 1.

### Reflects the 6/25 AI Architecture Group review

- **Lane 1 is the "light" path, not "host as-is."** There's a quick safety review
  (login, PR→preview→approve), and **you stay responsible for what it produces.**
- **Working on client/fund data is normal — it doesn't by itself need a sign-off.**
  The real gates are: it **updates a system of record**, it produces a **client
  deliverable others rely on**, or it **relies on AI/judgment output you don't review.**
- **Human-in-the-loop is the line:** a tool that surfaces results you review can be
  light; one whose unreviewed output is relied on is Lane 2.

### Understand *why* (not just *what*)

- **Show me where** — each deciding reason expands to the real source with the exact
  line highlighted, a plain note, and the `file:line`. Not a claim — the evidence.
- **Walk me through it** — a narrated, two-question decision path you can sit back and
  watch (or have read aloud), step by step, to its designation.
- **What would make it lighter** — each change shows the lane it *would* become,
  computed by re-running the engine with that one change applied (so it's honest when
  one change isn't enough on its own).
- **Know vs. assumed** — a trust line separates what the code *proves* from the few
  facts it had to *assume*, each one tap to confirm.

### UX (Apple/Anthropic-grade refinements)

Dark mode · full keyboard + screen-reader support (live verdict, focus management) ·
paste-a-link-or-code anywhere to analyze · "try an example" · View-Transitions morph ·
the CTA copies a plain-language hand-off note · live "change?" nudges · restrained
motion that respects `prefers-reduced-motion`.

## Layout

```
index.html              one card: input · analyzing · result  + audit drawer
server.js               zero-dependency static host
src/styles/app.css      design system (warm canvas, status orb, reason tiles)
src/app.js              controller + plain-language layer: sources -> engine -> render
src/engine/
  ruleset.js            the canonical signal set (mapped to the playbook)
  scan.js               regex scan -> evidence (file:line), runtime-scoped
  classify.js           two-step triage + verdict precedence
  sources.js            GitHub URL / folder / .zip / files / paste loaders
  index.js              public API
src/vendor/jszip.min.js vendored locally (no external CDN script)
test/
  corpus.json           20-case verification corpus
  run.mjs               replays the corpus through the engine
```

## Test

```bash
node test/run.mjs        # 20/20 on the Lane 1 vs Lane 2 decision
node test/run.mjs -v     # verbose, per-case
```

Lane (Lane 1 vs Lane 2) is the primary metric. The finer *Approve-state* suffix and
the exact tier depend on data-sensitivity and reliance facts that aren't code-
detectable, so they're reported as secondary.

## Governance source

Derived from the **GPFS POC Triage & Hosting Playbook** (§3 triage, §5 Lane 1
checklist, §6 Lane 2, §7 ownership/expiry) and the **GPFS Utility Hosting Platform**
proposal (Shared vs Isolated hosting). The AI tool used to *build* a utility never
affects its Lane — only the running behavior does.
