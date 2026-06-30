// smoke.mjs — the browser UI smoke test (the layer the node suite can't reach).
// Boots the real dev server, drives a headless Chromium through the actual UI, and
// FAILS on any uncaught error / console error. This is what would have caught the
// dormant History/Docs tools and the unwired Library before they shipped.
//
//   npm run test:ui     (needs: npm i -D playwright && npx playwright install chromium)
//
// Signed-out only (IndexedDB path) so it needs no cloud credentials. READER_FALLBACK=off
// + a dead Ollama means /api/llm degrades to a 503 and the engine read is shown — the UI
// flow (check -> result -> saved -> re-open) is exercised without any external LLM call.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 4319;
const base = `http://127.0.0.1:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } return !!cond; };

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log(`${R}Playwright not installed.${X} Run: npm i -D playwright && npx playwright install chromium`); process.exit(2); }

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', READER_FALLBACK: 'off', OLLAMA_HOST: 'http://127.0.0.1:9' },
  stdio: 'ignore',
});

async function waitReady(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(base + '/index.html')).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Benign console noise to ignore (the cloud client probes auth even when signed out).
const BENIGN = /AuthSessionMissing|session missing|favicon|Failed to load resource.*favicon/i;

let browser;
try {
  if (!ok('dev server boots', await waitReady())) throw new Error('server did not start');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();   // fresh storage (empty IndexedDB) per run
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const url = (m.location && m.location().url) || '';
    // Ignore the /api/llm 503s — by design the test runs with NO LLM backend (the engine
    // read is shown instead); the 503 path itself is covered by test/server.test.mjs.
    if (BENIGN.test(text) || /\/api\/llm/.test(url)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rail-tools .rail-btn', { timeout: 8000 });

  // ---- rail: every tool is live (no dormant placeholders) -------------------
  const tools = await page.$$eval('#rail-tools .rail-btn', (els) => els.map((b) => ({ tool: b.dataset.tool, dormant: b.classList.contains('dormant'), disabled: b.disabled })));
  ok('rail has validator/history/library/docs', ['validator', 'history', 'library', 'docs'].every((t) => tools.some((x) => x.tool === t)));
  ok('no dormant rail tools', tools.every((t) => !t.dormant && !t.disabled));

  // ---- History (clock) opens the recents sidebar ----------------------------
  await page.click('#rail-tools .rail-btn[data-tool="history"]');
  ok('History opens the sidebar', await page.getAttribute('#shell', 'data-side') === 'open');
  await page.click('#rail-tools .rail-btn[data-tool="history"]');   // toggle closed

  // ---- Docs opens the lanes-reference drawer --------------------------------
  await page.click('#rail-tools .rail-btn[data-tool="docs"]');
  ok('Docs opens the bottom drawer', await page.getAttribute('#shell', 'data-bottom') === 'open');
  await page.click('#rail-tools .rail-btn[data-tool="docs"]');

  // ---- empty canvas: example is a quiet chip, with hint + lane legend -------
  ok('example link reads "See an example →"', /See an example\s*→/.test(await page.textContent('#try-example')));
  ok('example link is an ex-chip', await page.$eval('#try-example', (b) => b.classList.contains('ex-chip')));
  ok('empty canvas shows the lane legend (3 dots)', (await page.$$('.lane-legend li')).length === 3);

  // ---- run a check via the built-in example ---------------------------------
  await page.click('#try-example');
  await page.waitForSelector('#card[data-state="result"]', { timeout: 20000 });
  ok('a check renders a result', /Good to go|developer|sign-off|Lane/i.test(await page.textContent('.view-result')));

  // the "What this looks like" summary is always present (AI text, or deterministic
  // fallback when no model is available — as in this no-backend test run). The header
  // copy was renamed from "Here's what I read" and now carries a neutral eye glyph.
  ok('result shows the upload summary', !!(await page.$('.view-result .summary .summary-text')) && (await page.textContent('.view-result .summary .summary-text')).trim().length > 0);
  ok('summary header reads "What this looks like"', /What this looks like/.test(await page.textContent('.view-result .summary .summary-head')));

  // footer in verdict state shows ONLY the coloured dot — no verdict words (the words
  // "Ready to host" / "Hand to a developer" / "Needs a sign-off" were removed).
  ok('footer verdict shows colour dot, no words', !!(await page.$('#foot-verdict .v-dot')) && (await page.textContent('#foot-verdict')).trim() === '');

  // the grey ".story" paragraph was removed from the rendered result (announce() still
  // uses it for screen readers, but it is no longer painted).
  ok('result has no .story paragraph', (await page.$$('.view-result .story')).length === 0);

  // ---- the check was saved -> History shows it, re-openable -----------------
  await page.click('#rail-tools .rail-btn[data-tool="history"]');
  await page.waitForSelector('#side-body .recent[data-id]', { timeout: 5000 });
  ok('saved check appears in History', (await page.$$('#side-body .recent[data-id]')).length >= 1);

  // ---- Library tool: grid + card actions ------------------------------------
  await page.click('#rail-tools .rail-btn[data-tool="library"]');
  ok('Library view is active', await page.getAttribute('#shell', 'data-tool') === 'library');
  await page.waitForSelector('#lib-grid .lib-card', { timeout: 5000 });
  ok('Library shows a saved card', (await page.$$('#lib-grid .lib-card')).length >= 1);
  ok('card has re-check/download/remove', (await page.$$('#lib-grid .lib-card .lib-act')).length >= 3);

  // re-open from the card (re-runs, switches to Validator, no duplicate)
  await page.click('#lib-grid .lib-card .lib-act[data-act="recheck"]');
  await page.waitForSelector('#card[data-state="result"]', { timeout: 20000 });
  ok('re-check re-opens to Validator', await page.getAttribute('#shell', 'data-tool') === 'validator');
  await page.click('#rail-tools .rail-btn[data-tool="library"]');
  await page.waitForTimeout(400);
  ok('re-open did not duplicate the asset', (await page.$$('#lib-grid .lib-card')).length === 1);

  // remove clears it
  await page.click('#lib-grid .lib-card .lib-act[data-act="remove"]');
  await page.waitForTimeout(500);
  ok('remove empties the Library', (await page.$$('#lib-grid .lib-card')).length === 0);

  // ---- account icon is the settings entry; Privacy has the save toggle ------
  await page.click('#account-btn');
  await page.waitForSelector('.set-overlay', { timeout: 4000 });
  ok('account icon opens Settings', await page.isVisible('.set-overlay'));
  const secs = await page.$$eval('.set-navitem', (els) => els.map((b) => b.dataset.sec));
  ok('Settings has Account + Appearance + Privacy', ['account', 'appearance', 'privacy'].every((s) => secs.includes(s)));
  await page.click('.set-navitem[data-sec="privacy"]');
  await page.waitForSelector('.set-content [data-act="toggle-save"]', { timeout: 3000 });
  ok('Privacy has the "Save my checks" toggle', !!(await page.$('.set-content [data-act="toggle-save"]')));

  // ---- no console errors anywhere -------------------------------------------
  ok(`no console/page errors${consoleErrors.length ? ' — ' + consoleErrors.slice(0, 3).join(' | ') : ''}`, consoleErrors.length === 0);
} catch (e) {
  fail++; console.log(`  ${R}✗ smoke run threw: ${e && e.message || e}${X}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGKILL');
}

console.log('');
if (fail === 0) console.log(`${G}${B}UI smoke: ${pass}/${pass} passed${X}`);
else console.log(`${R}${B}UI smoke: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
