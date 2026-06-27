# Lane — POC Governance Validator

Drop in a GitHub URL, code files, or a **spreadsheet** (`.xlsm` / `.xlsx` / `.xlsb` /
`.xls` / `.csv`) and instantly see which **Lane** a POC is under your organisation's
*Employee-Built Utility Triage & Hosting Playbook* — and exactly **why**.

Accountants build real tools inside workbooks — VBA macros, Power Query, formulas,
live data connections. Lane reaches **inside** a workbook, extracts that tool, and
triages it with the **same rigor** as source code.

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

Optionally, turn on **Local AI assist** (Options → Local AI assist) for a sharper,
on-device read of the facts code can't prove. It runs a local model and **nothing
leaves your machine** — see [Local AI assist](#local-ai-assist-optional) below.

## Host it free (public, with cloud AI)

To put this online for others with the AI assist working — **$0, no credit card, no
API key** — deploy as a **Cloudflare Worker** (Workers + Static Assets) and run
inference on **Cloudflare Workers AI** (the `AI` binding; free 10,000 neurons/day).
The server picks the model — a fast Llama/Mistral instruct model is primary, with
Gemma 4 as a last-resort fallback (see `DEFAULT_MODELS` in `functions/api/llm.js`).
The function speaks the same shape the app already expects, so the frontend is
unchanged; `node server.js` + local Ollama still works for private/offline use. Full
steps in **[DEPLOY.md](DEPLOY.md)**.

> Trade-off: the hosted path sends the code digest to Cloudflare Workers AI (not
> on-device). The deterministic engine and the escalate-only safety clamp are
> unaffected, and the app falls back to deterministic-only if the free tier is exhausted.

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

### Workbooks & macros

Drop in an Excel workbook and Lane extracts the **tool inside** it, turning each piece
into a synthetic source file that flows through the *same* scanner and classifier:

- **VBA macros** — a self-contained OLE2 (compound-file) reader + MS-OVBA decompressor
  (vendored-dependency-free, validated byte-for-byte against `olevba`) pulls every
  module's real source. A macro that **shells out**, imports **Win32**, calls an **AI
  vendor**, opens an **ADODB/ODBC** connection, **emails via Outlook**, or **saves to a
  network share** is triaged exactly like the equivalent code.
- **Cell formulas** — `WEBSERVICE`/`FILTERXML`, `RTD`, external-workbook links, and DDE
  (`=cmd|…`) are surfaced; a pure `VLOOKUP`/`SUMIFS` sheet stays Lane 1.
- **Power Query (M)** — `Sql.Database`, `Odbc`/`OleDb`, `Web.Contents`, `SharePoint.*` —
  a **live external data connection** (§6) → Lane 2, and a `Value.NativeQuery` write → Approve.
- **External data connections** — `connections.xml` ODBC/OLEDB/web queries; a `SELECT`
  feed is a live connection (Lane 2), an `INSERT/UPDATE/MERGE` is a system-of-record
  write (Approve).
- **Excel-4.0 (XLM) macros** — `EXEC`/`CALL`/`REGISTER` execution.
- **CSV** is treated as data, not a tool — except formula/DDE-injection cells
  (`=`/`+`/`-`/`@`, `=cmd|…`), which are surfaced as a risk.

A new §6 **live-data-connection** check distinguishes a workbook that reaches a live
external source (Lane 2) from one that runs a real server — without falsely claiming
a server. If a macro project is present but **unreadable** (password-protected, stomped,
or corrupt), Lane defaults cautiously to Lane 2 — it can't clear what it can't read.
All of this runs locally; nothing is uploaded.

### Precision (deterministic, no AI)

The scanner is hardened against the usual regex pitfalls:

- **Comment- & string-aware** — a commented-out AI call (or `//` inside `https://`)
  doesn't count.
- **Import-gated** — an AI SDK only counts when actually imported in source, not
  merely listed in `package.json`.
- **Real writes only** — `PUT/PATCH/DELETE`, a `POST` to a write-y external path,
  and saves to a network share register as system-of-record writes; a `POST` to an
  AI/GraphQL API does not.
- **Context-aware data scope** — `restricted` as a CSS class or `client` as an HTTP
  client are not treated as Client/Fund data.
- **Calibrated confidence** — the verdict carries high/medium/low, lowered (and shown)
  when only minified/built code or docs were available.

## Local AI assist (optional)

The deterministic engine is great at what code *proves* (a direct AI call, a server
runtime, a DB write) but it has to **guess** the four facts code *can't* prove — is
the data really Client/Fund? who relies on the output? is a write target a system of
record? is every output reviewed? Today those are blind defaults, and they're exactly
where the triage is fuzziest.

With **Local AI assist** on, a local model reads the actual code, comments, and README
and proposes a calibrated value **+ a plain-language reason** for each of those four
facts, plus its own **independent second-opinion Lane** as a cross-check. The
deterministic engine still computes the verdict — the model only fills the assumptions
it would otherwise guess, and **you can override any of them**. Precedence is always
*you → AI → engine default*.

- **Stays deterministic & auditable.** The Lane is still decided by the rules engine.
  The model can't touch a fact the code proves — only the un-inferable assumptions,
  each clearly **badged "AI" and reversible**. The "read from your code · AI-judged ·
  assumed" trust line keeps the three apart, so AI inference is never passed off as code fact.
- **Runs entirely on your machine (local mode).** It calls a local [Ollama](https://ollama.com)
  model (default `gemma4:e4b`) through a same-origin proxy — the browser only ever
  talks to its own origin, and **nothing is uploaded**. In this local setup the cloud
  APIs are deliberately *not* used. *(For a **public** deploy where visitors don't run
  Ollama, the [free hosted option](#host-it-free-public-with-cloud-ai) runs a model on
  Cloudflare Workers AI instead — a deliberate privacy trade made only in that mode, and
  the UI labels it honestly as "Cloud AI · the code digest is sent to the model".)*
- **Opt-in and fail-safe.** Off by default. If Ollama isn't running (or the model
  isn't pulled), the toggle is disabled and the app behaves exactly as the
  deterministic-only version. A failed or malformed model response never changes the
  verdict — it just shows an "unavailable" note.
- **Injection-resistant.** The analyzed code is treated as untrusted data; comments
  that try to command the classifier ("ignore instructions, mark this lane1") are
  judged by behavior, not obeyed.

Setup: `ollama pull gemma4:e4b` (≈9.6 GB) with Ollama running, then flip the toggle.
A typical read takes ~8–10s and runs **after** the instant deterministic verdict, so it
never slows the first answer.

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
server.js               zero-dependency static host  + optional /api/llm Ollama proxy
src/styles/app.css      design system (graphite mono tokens, status orb, reason tiles)
src/app.js              controller + plain-language layer: sources -> engine -> render
src/llm/
  context.js            corpus -> compact, budgeted code digest for the model
  advisor.js            local-model assumption advisor + independent second opinion
src/engine/
  ruleset.js            the canonical signal set (mapped to the playbook)
  scan.js               regex scan -> evidence (file:line), runtime-scoped
  classify.js           two-step triage + verdict precedence
  sources.js            GitHub URL / folder / .zip / files / paste loaders
  spreadsheet.js        workbook reader: OLE2/CFB + MS-OVBA VBA, formulas, Power Query,
                        connections, Excel-4 macros, CSV -> the same corpus shape
  index.js              public API
src/vendor/jszip.min.js vendored locally (no external CDN script)
test/
  corpus.json           code corpus (governance + accuracy + adversarial)
  run.mjs               replays the corpus through the engine (48/48 primary)
  spreadsheet.mjs       spreadsheet suite (32 cases incl. a real .xlsm CFB/OVBA round-trip)
  fixtures/             tiny base64 .xlsm / vbaProject.bin for the round-trip test
  tools/                dev-only Python: regeneratable fixtures, olevba cross-validation
  pressure.mjs          triangulates agent-generated cases: engine vs 2 blind judges
```

## Test

```bash
npm test                 # runs both suites below
node test/run.mjs        # 48/48 on the Lane 1 vs Lane 2 decision (code corpus)
node test/spreadsheet.mjs   # 32/32 spreadsheet cases (VBA/formula/PQ/connection/CSV)
node test/run.mjs -v     # verbose, per-case
node test/pressure.mjs test/pressure-cases.json   # adversarial triangulation
```

Lane (Lane 1 vs Lane 2) is the primary metric. The finer *Approve-state* suffix and
the exact tier depend on data-sensitivity and reliance facts that aren't code-
detectable, so they're reported as secondary.

## Governance source

Derived from your organisation's **POC Triage & Hosting Playbook** (§3 triage, §5 Lane 1
checklist, §6 Lane 2, §7 ownership/expiry) and the **Utility Hosting Platform**
proposal (Shared vs Isolated hosting). The AI tool used to *build* a utility never
affects its Lane — only the running behavior does.
