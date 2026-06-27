# Deploy free, with cloud AI (Cloudflare Workers AI)

This hosts the app publicly **for $0, no credit card, no separate API key**, using the
**Workers + Static Assets** model: a tiny Worker (`worker.js`) serves the static
front-end and routes `/api/*` to the handlers in `functions/`, and inference runs on
**Cloudflare Workers AI** via the `AI` binding — a fast Llama/Mistral instruct model
(see `DEFAULT_MODELS` in `functions/api/llm.js`), with Google's Gemma 4 as a
last-resort fallback. The server picks the model; the client never does.

> Deployed as a **Worker** (not classic Pages). Cloudflare's Git build runs
> `npx wrangler deploy`, which is a Workers command — so the project must be a
> **Worker**, and `wrangler.toml` is a Workers + Static Assets config (`main` +
> `[assets]`), not a Pages config. `functions/` is reused by `worker.js` so the
> request/response logic is shared.

Your local setup is untouched: `node server.js` + local Ollama still works for
private/offline dev. `worker.js` / `wrangler.toml` only power the public deploy.

## How it fits together

```
Browser ─▶ Worker (worker.js)
           ├─ /api/llm, /api/llm/health ─▶ functions/ handlers ─env.AI.run()─▶ Workers AI model
           └─ everything else            ─▶ env.ASSETS (static: index.html, src/, assets/)
```

- The handlers return an **Ollama-shaped** reply, so `src/llm/advisor.js` is unchanged.
- **No API key.** Inference runs through the `AI` binding, billed in *neurons* with a
  **free 10,000/day** allocation. If the binding is missing or the free tier is
  exhausted, the app **falls back to deterministic-only** (still 48/48).

## Deploy (dashboard — Workers Build from Git)

1. Cloudflare dashboard → **Workers & Pages → Create → Workers → Import a repository**.
2. Select **`amelas-dev/POC-Validator`** (that's the remote `origin` this repo pushes to).
3. Build configuration:
   - **Build command:** *(empty)*
   - **Deploy command:** `npx wrangler deploy`  ← Workers Builds default; leave it.
4. **Deploy.** `wrangler deploy` reads `wrangler.toml` (`main = "worker.js"`,
   `[assets] directory = "."`) and ships the Worker + static files.
5. Add the model binding: project → **Settings → Bindings → Add → Workers AI**,
   variable name **`AI`** → redeploy. (The `[ai]` block in `wrangler.toml` covers
   `wrangler dev`; production uses the binding configured on the Worker.)

Then open the Worker's URL → Options → **AI assist** → run a check; you'll get a
Workers AI read. Every `git push` to `main` auto-deploys from then on.

### If you already have a *Pages* project named `pocai`
A Worker config can't deploy into a Pages project. Create the **Worker** as above
(it may reuse the name `pocai`), then delete the old Pages project so it stops
auto-building: dashboard, or `npx wrangler pages project delete pocai`.

## Local dev / CLI deploy

```bash
npx wrangler login          # once
npx wrangler dev            # Worker + assets locally; AI runs on real Workers AI
npx wrangler deploy         # same command the Git build runs
```

## Quick checks

```bash
# Health — reports available:true when the AI binding is present
curl https://<your-worker-url>/api/llm/health

# A raw model call (mimics what advisor.js sends)
curl -X POST https://<your-worker-url>/api/llm \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma4:e4b","prompt":"Return a JSON object {\"dataScope\":\"general\"}.","options":{"temperature":0,"seed":0}}'
```

## Privacy note (changed from local mode)

Local AI assist keeps everything on-device. This hosted path sends the code **digest**
to Cloudflare Workers AI to get the read. The UI labels it honestly ("Cloud AI · the
code digest is sent to the model"), and the **escalate-only security clamp** in
`src/app.js` still holds — the AI can raise caution but can never silently lower the
deterministic baseline — so a hostile or rate-limited model can't weaken a verdict.
