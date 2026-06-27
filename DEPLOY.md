# Deploy free, with cloud AI (Gemma 4 on Cloudflare Workers AI)

This hosts the app publicly **for $0, no credit card, no separate API key**, with the
AI assist working for every visitor — running Google's **Gemma 4** model directly on
**Cloudflare Workers AI** (via the `AI` binding), hosted on **Cloudflare Pages**.

Gemma is the same model family the prompt was tuned against locally, so the hosted
read behaves like your local Ollama one — just on Cloudflare's GPUs instead of yours.

Your existing local setup is untouched: `node server.js` + local Ollama still works
for private/offline dev. The two files in `functions/` only power the public deploy.

## How it fits together

```
Browser ──fetch('/api/llm')──▶ Cloudflare Pages Function ──env.AI.run()──▶ Workers AI
  (src/llm/advisor.js,            (functions/api/llm.js)                    (Gemma 4,
   unchanged)                                                               free tier)
```

- The function returns an **Ollama-shaped** reply, so `advisor.js` needs **zero
  changes** — same `JSON.parse(outer.response)`, same flat 15-key contract.
- **No API key.** Inference runs through Cloudflare's `AI` binding, billed in
  *neurons* with a **free 10,000/day** allocation. Each validation is a handful.
- If the binding is missing or the free tier is exhausted, the function reports
  unavailable and the app **falls back to the deterministic-only verdict** (still
  48/48). The free tier is a soft ceiling, not a paywall.

## Why not GitHub Pages?

GitHub Pages serves static files only — it can't run the function or the model.
Cloudflare Pages does both, free, and deploys straight **from your GitHub repo**, so
your source stays on GitHub.

---

## Deploy on Cloudflare Pages (dashboard, no CLI)

1. Create a free account at <https://dash.cloudflare.com> → **Workers & Pages** →
   **Create** → **Pages** → **Connect to Git**.
2. Authorize GitHub and pick **`amelas-gpes/POC-Validator`**.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty — no build step)*
   - **Build output directory:** `/`
4. **Save and Deploy.** First build publishes the static app in ~1 minute.
5. Add the model binding: project → **Settings → Functions → Bindings → Add** →
   **Workers AI**, **Variable name `AI`** → Save.
6. **Deployments → Retry deployment** (the binding applies on the next build).

Done. Open the `*.pages.dev` URL, turn on **Options → AI assist**, and the read is
now served by Gemma 4 on Cloudflare for anyone who visits.

> Every `git push` to `main` auto-deploys from then on.

*(Optional)* To pin or change the model, add a **Variable** `CF_AI_MODEL`
(e.g. `@cf/google/gemma-4-26b-a4b-it`) in Settings → Environment variables.

---

## Test it locally first (optional)

Run the real Cloudflare Functions runtime on your machine. Workers AI has no local
emulator, so the `AI` binding runs against your real account — just log in first:

```bash
npx wrangler login          # once
npx wrangler pages dev .    # serves the app + /api/llm; AI runs on real Workers AI
```

Or deploy from the CLI instead of the dashboard:

```bash
npx wrangler pages deploy .   # wrangler.toml already declares the [ai] binding
```

## Quick checks

```bash
# Health — reports available:true when the AI binding is present
curl https://<your-project>.pages.dev/api/llm/health

# A raw model call (mimics what advisor.js sends)
curl -X POST https://<your-project>.pages.dev/api/llm \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma4:e4b","prompt":"Return a JSON object {\"dataScope\":\"general\"}.","options":{"temperature":0,"seed":0}}'
```

## Privacy note (changed from local mode)

Local AI assist keeps everything on-device. This hosted path sends the code **digest**
to Cloudflare Workers AI to get the read. That's the deliberate trade for free,
always-on cloud AI. The UI labels it honestly ("Cloud AI · the code digest is sent to
the model"), and the **escalate-only security clamp** in `src/app.js` still holds — the
AI can raise caution but can never silently lower the deterministic baseline — so a
hostile or rate-limited model can't weaken a verdict.
