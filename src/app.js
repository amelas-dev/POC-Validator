// app.js — Lane controller + plain-language presentation.
// The engine (src/engine) decides; this layer translates the decision into one
// glanceable, jargon-free answer and tucks the technical audit into a drawer.

import { extractFacts, resolve } from './engine/classify.js';
import {
  parseGitHubUrl, loadFromGitHub, loadFromFileList, loadFromZip, loadFromPaste,
} from './engine/sources.js';

const $ = (s) => document.querySelector(s);
const card = $('#card');       // the work canvas; data-state drives the view
const shell = $('#shell');     // the app-shell grid (rail · header · main · dock · footer)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tiny namespaced localStorage helper — the persistence seam the toolkit grows on.
const store = {
  get(k, d) { try { const v = localStorage.getItem('lane.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lane.' + k, JSON.stringify(v)); } catch {} },
};

// ---- state ----------------------------------------------------------------
let corpus = null;
let cachedFacts = null;   // assumption-independent facts; scanned once, reused per what-if toggle
let overrides = {};
let lastResult = null;
let currentWalkClose = null;  // teardown handle for an active walkthrough overlay

// State lives on the canvas (drives the views) and is mirrored to the shell
// (drives the analyzing sweep, the New-check button, and the drop hint).
function setState(s) {
  card.dataset.state = s;
  shell.dataset.state = s;
  const nc = $('#new-check'); if (nc) nc.hidden = (s !== 'result');
  $('#work')?.setAttribute('aria-busy', s === 'analyzing' ? 'true' : 'false');
}

// ---- plain-language vocabulary -------------------------------------------
const OUTCOME = { lane1: 'ready', lane2: 'developer', approve: 'signoff' };

const VERDICT = {
  ready: { headline: 'Good to go.', story: 'This can go live the light way — published behind login after a quick safety check. You stay responsible for what it does.', cta: 'Publish it', done: 'Copied ✓ — paste to publish', who: 'publish' },
  developer: { headline: 'Hand it to a developer.', story: 'A great start. A developer should build it out before it goes live — a normal next step, not a problem.', cta: 'Hand off to a developer', done: 'Copied ✓ — paste to your dev', who: 'a developer' },
  signoff: { headline: 'Needs a sign-off first.', story: 'It touches sensitive client or fund work, so a developer builds it and a committee gives the OK before launch.', cta: 'Request a sign-off', done: 'Copied ✓ — paste to the committee', who: 'the AI Committee' },
};

// per-condition plain copy: "Label — sentence."  +  an icon
const COND = {
  host: { icon: 'server', pass: 'Runs on its own — needs nothing special to go online.', fail: 'Needs its own engine — a developer has to set up where it lives.' },
  c51: { icon: 'users', pass: 'Just for you — only you use it, so the bar is low.', fail: 'Clients rely on it — its output reaches clients, so it gets extra care.' },
  c52: { icon: 'lock', pass: 'Data stays under your control — it reads or formats, and you review the result.', fail: 'Client & fund data, updated or unreviewed — that combination needs a sign-off.' },
  c53: { icon: 'pencil', pass: 'Doesn’t update any system of record — it only reads or formats.', fail: 'Changes official records — it updates a system people treat as the source of truth.' },
  c54: { icon: 'scale', pass: 'Follows fixed rules — the same input always gives the same answer.', reviewed: 'Makes judgment calls, but you review each result — fine for the light path.', fail: 'Makes judgment calls — it estimates or interprets, so a person should check its work.' },
  c55: { icon: 'sparkles', pass: 'Uses no outside AI — the safe way.', fail: 'Uses outside AI — it calls an AI service directly instead of the approved one.' },
  c56: { icon: 'globe', pass: 'Stays inside the company — nothing reaches the open internet.', fail: 'Reaches outside the company — it sends or pulls data from an outside service.' },
  c57: { icon: 'download', pass: 'Keeps nothing behind — doesn’t store data on the device.', fail: 'Saves data on the device — it keeps information on the computer it runs on.' },
};

const PATTERN = {
  'Data formatting': 'a data formatter', 'Data validation': 'a data checker',
  'Data entry / formatting': 'a data helper', 'Data entry / integration': 'a data tool',
  'Extraction / parsing': 'a document reader', 'Document Q&A / retrieval': 'a document assistant',
  'Drafting / summarizing': 'a writing helper', 'ML scoring / inference': 'a scoring tool', 'Utility': 'a small utility',
};

const WOULDBE = { lane1: 'the light path', lane2: 'developer-built', approve: 'a sign-off' };
const ANNOT = { host: 'custom server', c53: 'record update', c55: 'outside AI call', c56: 'outside-the-company call', c57: 'local data save', c54: 'judgment call', c52: 'client/fund data', c51: 'reliance on others' };

// Pull a few real lines around the deciding line from the loaded source.
function codeContext(path, line, radius = 1) {
  if (!corpus || !line) return null;
  const file = corpus.files.find((f) => f.path === path);
  if (!file) return null;
  const lines = file.text.split('\n');
  const idx = line - 1;
  const out = [];
  for (let i = Math.max(0, idx - radius); i <= Math.min(lines.length - 1, idx + radius); i++) out.push({ n: i + 1, text: lines[i], hot: i === idx });
  return out;
}

// soft "we guessed X — change?" nudges; clicking flips to the lighter value
const NUDGE = {
  dataScope: { heavy: ['restricted'], text: 'We assumed it touches client or fund data', flipTo: 'general' },
  reliance: { heavy: ['shared', 'deliverable'], text: 'We assumed other people rely on it', flipTo: 'personal' },
  writeAuthority: { heavy: ['authoritative'], text: 'We assumed it changes official records', flipTo: 'scratch' },
  humanReview: { heavy: ['no'], text: 'We assumed its output isn’t always reviewed', flipTo: 'yes' },
};

const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  server: I('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="0.5" fill="currentColor"/><circle cx="7" cy="16.5" r="0.5" fill="currentColor"/>'),
  users: I('<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M18 14.6c2 .7 3.5 2.4 3.5 4.9"/>'),
  lock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  pencil: I('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
  scale: I('<path d="M12 4v16"/><path d="M7 8h10"/><path d="M7 8l-3 6a3 3 0 0 0 6 0z"/><path d="M17 8l-3 6a3 3 0 0 0 6 0z"/><path d="M8.5 20h7"/>'),
  sparkles: I('<path d="M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5z"/><path d="M18.5 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/>'),
  download: I('<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  bolt: I('<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>'),
  chev: I('<path d="M9 6l6 6-6 6"/>'),
  arrowUp: I('<path d="M12 19V7"/><path d="M6 12l6-6 6 6"/>'),
  play: I('<path d="M8 5l11 7-11 7z"/>'),
  volume: I('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9a3 3 0 0 1 0 6"/>'),
  mute: I('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
};

// Polite screen-reader announcer for the verdict.
function announce(text) {
  let el = document.getElementById('sr-status');
  if (!el) { el = document.createElement('div'); el.id = 'sr-status'; el.className = 'sr-only'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  el.textContent = '';
  // next tick so repeated identical text still announces
  requestAnimationFrame(() => { el.textContent = text; });
}

const splitCopy = (s) => { const i = s.indexOf(' — '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 3)]; };

// The "who relies on it" row is driven by the reliance assumption, not the
// tier — so its words and state must match the selected value (never show
// "clients rely on it" while "just me" is chosen).
function relianceDisplay(v) {
  if (v === 'shared') return { copy: 'Your team relies on it — others use its results, so it should be more solid.', cls: 'work', txt: 'Heads up' };
  if (v === 'deliverable') return { copy: COND.c51.fail, cls: 'rev', txt: 'Review' };
  return { copy: COND.c51.pass, cls: 'ok', txt: 'Looks good' };
}

// The "logic" row depends on posture: deterministic reads one way; probabilistic
// that you review is fine; probabilistic that nobody checks is the problem.
function logicDisplay(posture, status) {
  if (posture === 'Green') return { copy: COND.c54.pass, cls: 'ok', txt: 'Looks good' };
  if (status === 'pass') return { copy: COND.c54.reviewed, cls: 'ok', txt: 'Looks good' };
  return { copy: COND.c54.fail, cls: 'work', txt: 'Needs work' };
}

// ============================================================================
//  Input
// ============================================================================
const urlInput = $('#url');
urlInput.addEventListener('input', () => {
  const ok = !!parseGitHubUrl(urlInput.value.trim());
  $('#analyze').disabled = !ok;
  $('#dropzone').classList.toggle('valid', ok && urlInput.value.trim().length > 0);
  clearError();
});
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#analyze').disabled) startGitHub(); });
$('#analyze').addEventListener('click', startGitHub);
function startGitHub() { run(() => loadFromGitHub(urlInput.value.trim(), $('#token').value.trim(), setPhase)); }

// Paste-to-analyze: paste a link or code anywhere on the input screen (not while
// typing in a field) and it just goes.
window.addEventListener('paste', (e) => {
  if (card.dataset.state !== 'input') return;
  const t = e.target;
  if (t && (t.id === 'url' || t.id === 'token')) return; // let the field handle it
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!text.trim()) return;
  e.preventDefault();
  if (parseGitHubUrl(text.trim())) { urlInput.value = text.trim(); run(() => loadFromGitHub(text.trim(), $('#token').value.trim(), setPhase)); }
  else run(() => Promise.resolve(loadFromPaste(text)));
});

// "Try an example" — a representative deterministic utility so first-timers see value.
const EXAMPLE = `<!doctype html>
<h2>Quarterly fee summary formatter</h2>
<textarea id="in" placeholder="paste raw amounts"></textarea>
<button id="fmt">Format</button><pre id="out"></pre>
<script>
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  document.getElementById('fmt').onclick = () => {
    const lines = document.getElementById('in').value.split('\\n');
    document.getElementById('out').textContent = lines
      .map(l => l.trim() === '' ? '' : usd.format(Number(l.replace(/[^0-9.\\-]/g, ''))))
      .join('\\n'); // display only — values are never changed
  };
</script>`;
const exBtn = $('#try-example');
if (exBtn) exBtn.addEventListener('click', () => run(() => Promise.resolve(loadFromPaste(EXAMPLE, 'example'))));

// One quiet picker for non-droppers (files; folders & .zip come in by drag).
const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
on('pick-files', 'click', () => $('#file-input').click());
on('file-input', 'change', (e) => e.target.files.length && run(() => loadFromFileList(e.target.files, setPhase)));
on('folder-input', 'change', (e) => e.target.files.length && run(() => loadFromFileList(e.target.files, setPhase)));
on('zip-input', 'change', (e) => e.target.files[0] && run(() => loadFromZip(e.target.files[0], setPhase)));

// drag anywhere over the canvas
['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); if (card.dataset.state === 'input') shell.dataset.drag = 'on'; }));
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) shell.removeAttribute('data-drag'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); shell.removeAttribute('data-drag');
  if (card.dataset.state !== 'input') return;
  const dt = e.dataTransfer;
  const items = dt.items ? Array.from(dt.items) : [];
  const dir = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).find((en) => en && en.isDirectory);
  if (dir) { run(() => corpusFromEntry(dir)); return; }
  const files = Array.from(dt.files || []);
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) { run(() => loadFromZip(files[0], setPhase)); return; }
  if (files.length) run(() => loadFromFileList(files, setPhase));
});

async function corpusFromEntry(rootEntry) {
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)); try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + entry.name }); } catch {} out.push(file); }
    else if (entry.isDirectory) { const entries = await new Promise((res) => entry.createReader().readEntries(res)); for (const ch of entries) await walk(ch, prefix + entry.name + '/'); }
  }
  await walk(rootEntry, '');
  return loadFromFileList(out, setPhase);
}

function showError(msg) { $('#error-text').textContent = msg; $('#error').classList.add('show'); }
function clearError() { $('#error').classList.remove('show'); }

// ============================================================================
//  Run pipeline
// ============================================================================
const PHASES = ['Reading your tool…', 'Checking what it touches…', 'Working out the verdict…'];
function setPhase(msg) { const el = $('#phase'); if (el && msg) el.textContent = msg; }

async function run(loader) {
  clearError();
  overrides = {};
  setState('analyzing');
  announce('Checking your tool…');
  let i = 0; setPhase(PHASES[0]);
  // Stop the generic rotation once it reaches the last phase so the loaders' granular
  // per-file progress ("Reading files… 7/40") can show through instead of being clobbered.
  const timer = setInterval(() => { i = Math.min(i + 1, PHASES.length - 1); setPhase(PHASES[i]); if (i === PHASES.length - 1) clearInterval(timer); }, 460);
  const dwell = new Promise((r) => setTimeout(r, 1250));
  try {
    const loaded = await loader();
    if (!loaded || !loaded.files || !loaded.files.length) throw new Error('No readable code files were found. Try a different repo, folder, or paste a snippet.');
    corpus = loaded;
    cachedFacts = extractFacts(corpus); // scan once; what-if toggles reuse this
    await dwell;
    clearInterval(timer);
    const reveal = () => { renderResult(); recordCheck(lastResult); setState('result'); };
    if (document.startViewTransition) document.startViewTransition(reveal); else reveal();
  } catch (err) {
    clearInterval(timer);
    setState('input');
    const m = String((err && err.message) || err);
    if (NEEDS_TOKEN.test(m)) $('#token-row').classList.add('open'); // reveal exactly when needed
    showError(friendly(m));
  }
}
// One source of truth for "this error means the user needs a GitHub token" (rate-limit /
// private / 404). friendly() takes the already-stringified message — no second stringify.
const NEEDS_TOKEN = /rate limit|private|token|not found/i;
function friendly(m) {
  if (/rate limit|not found|private/i.test(m)) return m;
  if (/reach|network|failed|fetch/i.test(m)) return 'Couldn’t reach that repo. Check the link, or drop the files instead.';
  return m;
}

// ============================================================================
//  Render result (the glanceable view)
// ============================================================================
function slugOf(r) { return r.meta.source === 'github' && r.meta.repoMeta.owner ? `${r.meta.repoMeta.owner}/${r.meta.repoMeta.repo}` : r.meta.label; }

function renderResult() {
  const r = resolve(cachedFacts, overrides);
  lastResult = r;
  const outcome = OUTCOME[r.verdict.key];
  const v = VERDICT[outcome];
  const slug = slugOf(r);
  const pat = PATTERN[r.pattern] || 'a small utility';

  const drivers = r.conditions.filter((c) => c.driving);
  const tiles = (outcome === 'ready' || drivers.length === 0)
    ? `<div class="tile" style="animation-delay:0ms"><div class="ic">${ICONS.check}</div><div class="tx"><div class="label">Nothing’s holding it back</div><div class="desc">It runs on its own, on everyday info, with no surprises.</div></div></div>`
    : drivers.slice(0, 3).map((c, i) => driverTile(c, i, r)).join('');

  const lighten = (r.lighten || []);
  const lp = lighten[0];
  const lightenPill = (outcome !== 'ready' && lp)
    ? `<button class="lighten" id="lighten-btn" aria-label="What would make it lighter">
         <span class="bolt">${ICONS.bolt}</span>
         <span><b>One change → ${esc(WOULDBE[lp.wouldBe] || 'lighter')}:</b> ${esc(lp.text)}${lighten.length > 1 ? ` <em>+${lighten.length - 1} more</em>` : ''}</span>
       </button>` : '';

  const cert = r.certainty || { proven: 0, assumed: 0 };
  const conf = r.confidence || { level: 'high', reasons: [] };
  const confChip = conf.level !== 'high'
    ? `<span class="t-sep">·</span><span class="t-conf t-conf-${conf.level}" title="${esc(conf.reasons.join(' '))}">${conf.level} confidence</span>` : '';
  const trust = `<button class="trust" id="trust-line" aria-label="See the full check">
      <span class="t-proven">${ICONS.check} ${cert.proven} read from your code</span>
      ${cert.assumed ? `<span class="t-sep">·</span><span class="t-assumed">${cert.assumed} assumed</span>` : ''}
      ${confChip}
      <span class="t-sep">·</span><span class="t-link">see the full check</span>
    </button>`;

  $('#result').dataset.outcome = outcome;
  $('#result').innerHTML = `
    <div class="hero">
      <div class="orb" aria-hidden="true"></div>
      <div><div class="headline">${esc(v.headline)}</div></div>
    </div>
    <div class="story">${esc(v.story)}</div>
    <div class="caption"><span class="slug">${esc(slug)}</span> · looks like ${esc(pat)}</div>
    ${trust}

    <div class="reasons-eyebrow">${drivers.length && outcome !== 'ready' ? 'Here’s what decided it' : 'The all-clear'}</div>
    <div class="tiles">${tiles}</div>
    ${lightenPill}

    <div class="action">
      <button class="ghost walk" id="walk"><span class="play">${ICONS.play}</span> Walk me through it</button>
      <div class="spacer"></div>
      <button class="cta" id="cta">${esc(v.cta)}</button>
    </div>`;

  announce(`${v.headline} ${v.story}`);
  updateFooter(r);
  if (shell.dataset.dock === 'open') renderDrawer();   // keep an open dock in sync with the verdict

  $('#trust-line').addEventListener('click', openDrawer);
  $('#cta').addEventListener('click', () => copyHandoff(r, v));
  $('#walk').addEventListener('click', () => startWalkthrough(r));
  const lb = $('#lighten-btn'); if (lb) lb.addEventListener('click', openLighten);
  $('#result').querySelectorAll('.show-where').forEach((b) => b.addEventListener('click', () => {
    const tile = b.closest('.tile');
    const open = tile.classList.contains('open');
    $('#result').querySelectorAll('.tile.open').forEach((t) => t.classList.remove('open'));
    if (!open) tile.classList.add('open');
  }));
  $('#result').querySelectorAll('.nudge').forEach((n) => n.addEventListener('click', () => {
    setOverride(n.dataset.kind, n.dataset.flip); renderResult();
  }));
}

// #1 — a driving reason tile that can spotlight the exact line in the real code.
function driverTile(c, i, r) {
  const def = COND[c.id] || { icon: 'check', fail: c.sentence };
  const copy = c.id === 'c51' ? relianceDisplay(c.assumption && c.assumption.value).copy : (def.fail || c.sentence);
  const [label, desc] = splitCopy(copy);
  const ev = (c.evidence && c.evidence[0]) || null;
  const ctx = ev ? codeContext(ev.path, ev.line) : null;
  const spotlight = ctx ? `
    <button class="show-where">show me where ${ICONS.chev}</button>
    <div class="spotlight">
      <div class="code">${ctx.map((l) => `<div class="cl${l.hot ? ' hot' : ''}"><span class="n">${l.n}</span><span class="t">${esc(l.text) || ' '}</span></div>`).join('')}</div>
      <div class="annot"><span class="up">${ICONS.arrowUp}</span> This line is the ${esc(ANNOT[c.id] || 'reason')}.${ev.line ? ` <span class="loc">${esc(ev.path)}:${ev.line}</span>` : ''}</div>
    </div>` : '';
  return `<div class="tile" style="animation-delay:${i * 70}ms">
    <div class="ic">${ICONS[def.icon] || ICONS.check}</div>
    <div class="tx">
      <div class="label">${esc(label)}</div>
      ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
      ${nudgeFor(c, r)}
      ${spotlight}
    </div>
  </div>`;
}

// CTA copies a plain-language hand-off note to the clipboard (no backend to post to).
async function copyHandoff(r, v) {
  const reasons = r.conditions.filter((c) => c.driving).map((c) => {
    const def = COND[c.id] || {};
    const copy = c.id === 'c51' ? relianceDisplay(c.assumption && c.assumption.value).copy : (def.fail || c.sentence);
    return '• ' + copy;
  });
  const lighten = (r.lighten || []).map((l) => '• ' + l.text + (l.wouldBe ? `  (→ ${WOULDBE[l.wouldBe] || 'lighter'})` : ''));
  const note = [
    `Lane check — ${slugOf(r)}`,
    `Verdict: ${v.headline} ${v.story}`,
    reasons.length ? `\nWhat decided it:\n${reasons.join('\n')}` : '',
    lighten.length ? `\nWhat would make it lighter:\n${lighten.join('\n')}` : '',
    `\nFor: ${v.who}. (Automated triage indication — the AI Operations Lead makes the call.)`,
  ].filter(Boolean).join('\n');
  try { await navigator.clipboard.writeText(note); } catch { /* clipboard may be blocked */ }
  const b = $('#cta'); b.textContent = v.done; b.classList.add('done'); b.disabled = true;
  announce(v.done);
}

// #2 + #3 — "Walk me through it": the decision path narrated step by step,
// optionally read aloud, so the user can sit back and just follow the logic.
function walkSteps(r) {
  const v = VERDICT[OUTCOME[r.verdict.key]];
  const ds = r.assumptions.dataScope;
  const steps = [{ k: 'start', t: `Here’s how ${slugOf(r)} got its designation — in two questions.` }];
  steps.push({ k: 'touches', t: ds === 'restricted'
    ? 'First: what does it work with? It touches client or fund data.'
    : 'First: what does it work with? Everyday data — nothing client or fund.' });
  if (r.verdict.key === 'lane1') {
    steps.push({ k: 'gate', t: 'Second: does it change records or rely on unreviewed output? No — it only reads or formats, stays inside the company, and you review what it produces.' });
  } else {
    const parts = r.conditions.filter((c) => c.driving).slice(0, 2).map((c) => {
      const copy = c.id === 'c51' ? relianceDisplay(c.assumption && c.assumption.value).copy : (COND[c.id]?.fail || c.sentence);
      const label = splitCopy(copy)[0];
      return label.charAt(0).toLowerCase() + label.slice(1); // lowercase first letter, keep "AI"
    });
    steps.push({ k: 'gate', t: `Second: does it cross a line that needs more care? Yes — ${parts.join(', and ')}.` });
  }
  steps.push({ k: 'land', t: `So it lands here: ${v.headline} ${v.story}` });
  return steps;
}

function startWalkthrough(r) {
  const steps = walkSteps(r);
  let idx = 0;
  let voice = false;                          // default off — TTS only when asked (no surprise audio)
  const trigger = document.activeElement;
  const washed = document.querySelectorAll('.rail, .toolhead, .dock, .foot');
  const ov = document.createElement('div');
  ov.className = 'walk-overlay';
  ov.dataset.outcome = OUTCOME[r.verdict.key];
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Walk me through it');
  $('#work').appendChild(ov);
  shell.dataset.walk = 'on';
  washed.forEach((el) => el.setAttribute('inert', ''));
  const stopSpeak = () => { try { window.speechSynthesis.cancel(); } catch {} };
  const speak = (t) => { if (!voice || !('speechSynthesis' in window)) return; try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.rate = 1.03; window.speechSynthesis.speak(u); } catch {} };
  const close = () => {
    stopSpeak(); ov.remove(); shell.removeAttribute('data-walk');
    washed.forEach((el) => el.removeAttribute('inert'));
    currentWalkClose = null;
    if (trigger && trigger.focus) trigger.focus();
  };
  const go = (n) => { idx = Math.max(0, Math.min(steps.length - 1, n)); render(); };
  function render() {
    if (!ov.isConnected) return;
    const s = steps[idx];
    ov.innerHTML = `
      <button class="walk-close" aria-label="Close walkthrough">✕</button>
      <div class="walk-card">
        <div class="walk-dots" aria-hidden="true">${steps.map((_, j) => `<span class="${j < idx ? 'past' : j === idx ? 'on' : ''}"></span>`).join('')}</div>
        <div class="walk-text">${esc(s.t)}</div>
        <div class="walk-ctrl">
          <button class="ghost sm" data-act="prev" ${idx === 0 ? 'disabled' : ''}>Back</button>
          <button class="voice ${voice ? 'on' : ''}" data-act="voice" aria-pressed="${voice}" aria-label="${voice ? 'Stop reading aloud' : 'Read aloud'}">${voice ? ICONS.volume : ICONS.mute}</button>
          <button class="cta sm" data-act="next">${idx === steps.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>`;
    ov.querySelector('.walk-close').onclick = close;
    ov.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'next') { if (idx === steps.length - 1) close(); else go(idx + 1); }
      else if (a === 'prev') go(idx - 1);
      else if (a === 'voice') { voice = !voice; if (!voice) stopSpeak(); else speak(s.t); render(); }
    }; });
    announce(s.t);                              // mirror each step to the live region
    speak(s.t);
    (ov.querySelector('[data-act="next"]') || ov).focus();
  }
  currentWalkClose = close;
  render();
}

function nudgeFor(cond, r) {
  const a = cond.assumption;
  if (!a) return '';
  const n = NUDGE[a.kind];
  if (!n) return '';
  if (r.assumptions.overridden[a.kind]) return '';
  if (!n.heavy.includes(String(a.value))) return '';
  return `<button class="nudge" data-kind="${esc(a.kind)}" data-flip="${esc(n.flipTo)}">${esc(n.text)} — change?</button>`;
}

function setOverride(kind, val) {
  if (kind === 'humanReview') overrides.humanReview = (val === 'yes');
  else overrides[kind] = val;
}

// ============================================================================
//  Full-check drawer (the audit, on demand)
// ============================================================================
const STATE_COPY = { pass: ['ok', 'Looks good'], lane2: ['work', 'Needs work'], review: ['rev', 'Review'] };
const QLABEL = { dataScope: 'The data is', reliance: 'Relied on by', writeAuthority: 'The records it changes are', humanReview: 'Its output is' };

// The audit is a DOCKED peer panel (Region D), not a modal. On wide screens it
// docks beside the verdict (no scrim) and re-resolves the verdict live; on
// narrow screens (≤1100px) CSS turns it into an overlay and we move focus in.
let drawerReturnFocus = null;
const isNarrow = () => window.matchMedia('(max-width: 1100px)').matches;
function openDrawer() {
  if (shell.dataset.dock !== 'open') { renderDrawer(); drawerReturnFocus = document.activeElement; }
  shell.dataset.dock = 'open';
  syncPanelBtn('dock', true); store.set('panel.dock', true);
  $('#dock-toggle')?.setAttribute('aria-expanded', 'true');
  if (isNarrow()) $('#drawer-close').focus();
}
function openLighten() {
  openDrawer();
  requestAnimationFrame(() => {
    const lb = $('#drawer-body .lighten-block');
    if (lb) { lb.scrollIntoView({ block: 'nearest' }); lb.classList.add('pulse'); setTimeout(() => lb.classList.remove('pulse'), 1400); }
  });
}
function closeDrawer() {
  if (shell.dataset.dock !== 'open') return;
  shell.dataset.dock = 'closed';
  syncPanelBtn('dock', false); store.set('panel.dock', false);
  $('#dock-toggle')?.setAttribute('aria-expanded', 'false');
  if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
}
// scrim sits behind whichever overlay is open on narrow screens — close them
$('#scrim')?.addEventListener('click', () => { closeDrawer(); setSidebar(false); });
$('#drawer-close').addEventListener('click', closeDrawer);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (currentWalkClose) { currentWalkClose(); return; }
  if (shell.dataset.dock === 'open') { closeDrawer(); return; }
  if (shell.dataset.side === 'open') { setSidebar(false); return; }
});

function renderDrawer() {
  const r = lastResult;
  if (!r) {
    $('#drawer-body').innerHTML = `<div class="side-empty" style="padding:44px 18px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16 16l4.5 4.5"/></svg>
      <div>Run a check to see the full audit — every condition in plain words, with the evidence from your code.</div>
    </div>`;
    return;
  }
  const rows = r.conditions.map((c) => {
    const def = COND[c.id] || {};
    let stClass, stText, copy;
    if (c.id === 'c51') {
      const d = relianceDisplay(c.assumption && c.assumption.value);
      stClass = d.cls; stText = d.txt; copy = d.copy;
    } else if (c.id === 'c54') {
      const d = logicDisplay(r.posture, c.status);
      stClass = d.cls; stText = d.txt; copy = d.copy;
    } else {
      [stClass, stText] = STATE_COPY[c.status] || STATE_COPY.lane2;
      copy = c.status === 'pass' ? (def.pass || c.sentence) : (def.fail || c.sentence);
    }
    const [label, desc] = splitCopy(copy);
    const assume = c.assumption ? assumeHTML(c.assumption) : '';
    const ev = (c.evidence && c.evidence.length)
      ? `<div class="tech">${c.evidence.map((e) => `<div class="ev"><span class="loc">${e.line ? esc(e.path) + ':' + e.line : esc(e.path)}</span>  ${esc(e.text)}</div>`).join('')}</div>`
      : '';
    return `<div class="chk">
      <div class="ci ${stClass}">${ICONS[def.icon] || ICONS.check}</div>
      <div class="cb">
        <div class="cl">${esc(label)}</div>
        ${desc ? `<div class="cd">${esc(desc)}</div>` : ''}
        ${assume}
        <div class="tech"><div class="meta-line">${esc(c.ref)} · ${ev ? `${c.evidence.length} place(s) in code` : 'no code evidence'}</div></div>
        ${ev}
      </div>
      <span class="state ${stClass}">${esc(stText)}</span>
    </div>`;
  }).join('');

  const v = VERDICT[OUTCOME[r.verdict.key]];
  const cert = r.certainty || { proven: 0, assumed: 0 };
  const conf = r.confidence || { level: 'high', reasons: [] };
  const certBlock = `<div class="cert-block">
      <span class="cert-proven">${ICONS.check} ${cert.proven} read straight from your code</span>
      ${cert.assumed ? `<span class="cert-assumed">${cert.assumed} we had to assume — confirm below</span>` : '<span class="cert-assumed">nothing left to assume</span>'}
      ${conf.level !== 'high' ? `<span class="cert-conf cert-conf-${conf.level}">${conf.level} confidence — ${esc(conf.reasons[0] || '')}</span>` : ''}
    </div>`;
  const lighten = (r.lighten || []);
  const lightenBlock = lighten.length ? `
    <div class="lighten-block">
      <div class="lb-head"><span class="bolt">${ICONS.bolt}</span> What would make it lighter</div>
      ${lighten.map((l) => `<div class="lb-item">${esc(l.text)} ${l.wouldBe ? `<span class="lb-would">→ ${esc(WOULDBE[l.wouldBe] || 'lighter')}</span>` : ''}</div>`).join('')}
    </div>` : '';
  $('#drawer-body').innerHTML = `
    <p style="font-size:13px;color:var(--muted);line-height:1.5;margin:10px 0 6px">
      ${esc(v.headline)} Every check below in plain words — adjust anything we had to assume and the verdict updates.
    </p>
    ${certBlock}
    ${lightenBlock}
    ${rows}
    <button class="tech-toggle" id="tech-toggle">Show technical detail</button>
    <div class="meta-line" id="gov-line" style="display:none;margin-top:10px">
      Governance: ${esc(r.verdict.lane)} · ${esc(r.tier)} tier · ${esc(r.posture)} logic.<br>${esc(r.verdict.hosting)}
    </div>`;

  $('#drawer-body').querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    setOverride(b.dataset.kind, b.dataset.val); renderResult();   // renderResult refreshes the open dock
  }));
  let techOn = false;
  $('#tech-toggle').addEventListener('click', () => {
    techOn = !techOn;
    $('#drawer-body').querySelectorAll('.tech').forEach((t) => t.classList.toggle('open', techOn));
    $('#gov-line').style.display = techOn ? 'block' : 'none';
    $('#tech-toggle').textContent = techOn ? 'Hide technical detail' : 'Show technical detail';
  });
}

function assumeHTML(a) {
  const opts = a.options.map((o) => `<button data-kind="${esc(a.kind)}" data-val="${esc(o.value)}" class="${o.value === a.value ? 'on' : ''}">${esc(o.label)}</button>`).join('');
  return `<div class="assume"><span class="q">${esc(QLABEL[a.kind] || 'Assumed')}</span><span class="seg">${opts}</span></div>`;
}

// ============================================================================
function reset() {
  if (currentWalkClose) currentWalkClose(); else document.querySelector('.walk-overlay')?.remove();
  try { window.speechSynthesis.cancel(); } catch {}
  closeDrawer();
  corpus = null; cachedFacts = null; overrides = {}; lastResult = null;
  setState('input');
  resetFooter();
  urlInput.value = ''; $('#analyze').disabled = true;
  $('#dropzone').classList.remove('valid');
  $('#token-row').classList.remove('open');
  clearError();
  urlInput.focus();
}

// ============================================================================
//  Shell — activity rail (tool registry), header options, theme, status footer
// ============================================================================

// The extensibility contract: one entry per tool (a rail icon + a canvas view +
// optional dock/footer hooks). Adding a tool = one row here. Today only the
// Validator is live; the rest are registered-but-dormant so the rail shows the
// shape of the toolkit without dead links.
const TOOLS = [
  { id: 'validator', label: 'Validator', enabled: true, icon: '<circle cx="11" cy="11" r="7"/><path d="M16 16l4.5 4.5"/>' },
  { id: 'history', label: 'History', enabled: false, icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  { id: 'library', label: 'Library', enabled: false, icon: '<rect x="4" y="4" width="6.2" height="16" rx="1.4"/><rect x="13.8" y="4" width="6.2" height="16" rx="1.4"/>' },
  { id: 'docs', label: 'Docs', enabled: false, icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h5"/>' },
];

function renderRail() {
  const host = $('#rail-tools'); if (!host) return;
  host.innerHTML = TOOLS.map((t) => {
    const active = t.id === shell.dataset.tool;
    return `<button class="rail-btn${t.enabled ? '' : ' dormant'}" type="button" role="listitem" data-tool="${t.id}"
        ${t.enabled ? '' : 'disabled tabindex="-1"'} ${active ? 'aria-current="page"' : ''}
        aria-label="${esc(t.enabled ? t.label : t.label + ' — coming soon')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
        <span class="tip">${esc(t.enabled ? t.label : t.label + ' · soon')}</span>
      </button>`;
  }).join('');
  host.querySelectorAll('.rail-btn:not(.dormant)').forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));
}
function selectTool(id) {
  const t = TOOLS.find((x) => x.id === id);
  if (!t || !t.enabled) return;
  shell.dataset.tool = id;
  $('#th-name').textContent = t.label;
  renderRail();
}

// ---- theme (Auto / Light / Dark), remembered -------------------------------
function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  store.set('theme', mode);
  $('#theme-seg')?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.theme === mode));
}

// ---- status footer ---------------------------------------------------------
const FOOT_VERDICT = { lane1: 'Ready to host', lane2: 'Hand to a developer', approve: 'Needs a sign-off' };
function updateFooter(r) {
  shell.dataset.outcome = OUTCOME[r.verdict.key];
  const fv = $('#foot-verdict');
  fv.dataset.kind = 'verdict';
  fv.innerHTML = `<span class="v-dot"></span><span class="foot-txt">${esc(FOOT_VERDICT[r.verdict.key] || '')}</span>`;
  const conf = r.confidence || { level: 'high', reasons: [] };
  $('#foot-conf').textContent = conf.level !== 'high' ? `Lower confidence — ${conf.reasons[0] || 'limited code to read'}` : '';
}
function resetFooter() {
  shell.removeAttribute('data-outcome');
  const fv = $('#foot-verdict');
  fv.dataset.kind = 'privacy';
  fv.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span class="foot-txt">Read-only · checked in your browser, never uploaded.</span>`;
  $('#foot-conf').textContent = '';
}

// ---- recents (the History seam) — a lightweight record per check, never code -
function recordCheck(r) {
  if (!r) return;
  const list = store.get('recents', []);
  list.unshift({ slug: slugOf(r), source: r.meta.source, verdict: r.verdict.key,
    proven: (r.certainty || {}).proven || 0, assumed: (r.certainty || {}).assumed || 0,
    confidence: (r.confidence || {}).level || 'high' });
  store.set('recents', list.slice(0, 50));
  if (shell.dataset.side === 'open') renderSidebar();
}

// ============================================================================
//  Expandable panels — left sidebar (recent checks) · bottom drawer (reference)
//  · right dock (the full check, handled by openDrawer/closeDrawer below). Each
//  is a real grid region with a header panel-toggle, remembered across reloads.
// ============================================================================
const PANEL_BTN = { side: '#panel-left', bottom: '#panel-bottom', dock: '#panel-right' };
function syncPanelBtn(name, open) { $(PANEL_BTN[name])?.setAttribute('aria-pressed', String(open)); }

function setSidebar(open) {
  shell.dataset.side = open ? 'open' : 'closed';
  syncPanelBtn('side', open); store.set('panel.side', open);
  if (open) renderSidebar();
}
function setBottom(open) {
  shell.dataset.bottom = open ? 'open' : 'closed';
  syncPanelBtn('bottom', open); store.set('panel.bottom', open);
}

const RECENT_LABEL = { lane1: 'Ready to host', lane2: 'Hand to a developer', approve: 'Needs a sign-off' };
function renderSidebar() {
  const host = $('#side-body'); if (!host) return;
  const list = store.get('recents', []);
  if (!list.length) {
    host.innerHTML = `<div class="side-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
      <div>Your checked tools will show up here.</div>
    </div>`;
    return;
  }
  host.innerHTML = list.map((r) => `<div class="recent" role="listitem" data-v="${esc(r.verdict)}">
      <span class="rdot" aria-hidden="true"></span>
      <span class="rtx"><span class="rslug">${esc(r.slug)}</span><span class="rmeta">${esc(RECENT_LABEL[r.verdict] || '')} · ${r.proven} read · ${r.assumed} assumed</span></span>
    </div>`).join('')
    + `<button class="side-clear" id="side-clear" type="button">Clear history</button>`;
  $('#side-clear')?.addEventListener('click', () => { store.set('recents', []); renderSidebar(); });
}

// ---- wire the shell once ---------------------------------------------------
function initShell() {
  renderRail();
  applyTheme(store.get('theme', 'auto'));
  resetFooter();

  const optsBtn = $('#opts-btn'), optsMenu = $('#opts-menu');
  const closeOpts = () => { optsMenu.hidden = true; optsBtn.setAttribute('aria-expanded', 'false'); };
  const toggleOpts = () => { const open = optsMenu.hidden; optsMenu.hidden = !open; optsBtn.setAttribute('aria-expanded', String(open)); };
  optsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleOpts(); });
  $('#settings-btn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleOpts(); });
  optsMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeOpts);
  $('#theme-seg')?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));

  $('#new-check')?.addEventListener('click', reset);
  $('#dock-toggle')?.addEventListener('click', closeDrawer);
  $('#playbook-link')?.addEventListener('click', (e) => { e.preventDefault(); setBottom(true); });

  // expandable panels — left sidebar · bottom drawer · right dock
  renderSidebar();
  $('#panel-left')?.addEventListener('click', () => setSidebar(shell.dataset.side !== 'open'));
  $('#panel-bottom')?.addEventListener('click', () => setBottom(shell.dataset.bottom !== 'open'));
  $('#panel-right')?.addEventListener('click', () => { if (shell.dataset.dock === 'open') closeDrawer(); else openDrawer(); });
  $('#side-close')?.addEventListener('click', () => setSidebar(false));
  $('#bottom-close')?.addEventListener('click', () => setBottom(false));

  // restore remembered layout
  if (store.get('panel.side', false)) setSidebar(true);
  if (store.get('panel.bottom', false)) setBottom(true);
  if (store.get('panel.dock', false)) openDrawer();
}

initShell();
urlInput.focus();
