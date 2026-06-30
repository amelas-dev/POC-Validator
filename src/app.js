// app.js — Lane controller + plain-language presentation.
// The engine (src/engine) decides; this layer translates the decision into one
// glanceable, jargon-free answer and tucks the technical audit into a drawer.

import { extractFacts, hydrateFacts, resolve } from './engine/classify.js';
import {
  parseGitHubUrl, loadFromGitHub, loadFromFileList, loadFromZip, loadFromPaste,
  loadFromPastes, guessPasteName,
} from './engine/sources.js';
import { loadFromSpreadsheet, isSpreadsheet } from './engine/spreadsheet.js';
import { runAdvisor, checkAvailable, DEFAULT_MODEL } from './llm/advisor.js';
import { wouldRelax } from './llm/clamp.js';
import {
  cloudConfigured, initAuth, currentUser, isSignedIn, onAuth,
  signIn, signUp, signOut, clearChecks,
} from './cloud/supabase.js';
// The asset Library: every checked tool is saved here (IndexedDB on this device, or
// Supabase Storage when signed in) so History and the Library tool can re-open it.
import { putAsset, getAsset, listAssets, deleteAsset, clearAssets } from './library/store.js';

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

// ---- the reading engine (deterministic rules + judgment) ------------------
// The app gives one read. The deterministic engine (src/engine) is its backbone
// and safety floor — it decides the verdict from what the code PROVES. Four facts
// can't be proven from code (is the data really Client/Fund? who relies on it? is
// a write target authoritative? is every output reviewed?); a model reads the
// actual code to judge those, and they feed the SAME resolver. This is woven into
// the read silently — there is no "AI mode", no toggle, nothing to surface.
//
// One invariant is non-negotiable and stays enforced under the hood: the analyzed
// code is untrusted and a model can be talked into anything by a comment, so a
// judged read may add caution but may NEVER push the verdict below the engine's
// cautious floor on its own. A lighter read only ever takes effect when the user
// chooses it by hand (via the adjustable assumptions). See computeView().
let aiAvailable = null;   // {ollama, available, model, provider} — where the read runs (for the privacy line)
let aiState = 'off';      // off | running | done | failed
let aiResult = null;      // the judged read (suggestions for the four un-inferable facts)
let aiOverrides = {};     // those judgments mapped to engine override keys
let aiAbort = null;       // AbortController for the in-flight read
let aiRunId = 0;          // guards against a stale read resolving over a newer run
let lastView = null;      // {r, baseline, aiApplied, aiHeld} — what renderResult resolved

// The verdict the engine reaches from ONLY code-certain facts + the user's own
// overrides — no AI. This is the safety FLOOR: the code is untrusted, the local
// model is prompt-injectable, so AI may add caution but must never silently make
// the verdict lighter than this. A trusted human (a manual toggle) still can.
function baselineResolve() { return resolve(cachedFacts, overrides); }

// Resolve the displayed view with the clamp applied:
//  - AI off / no suggestions  -> the baseline.
//  - AI agrees or escalates    -> apply its suggestions (more caution is fail-safe).
//  - AI would DE-escalate      -> HOLD it; keep the baseline and surface the AI's
//                                 lighter read as an explicit, user-confirmable suggestion.
function computeView() {
  const baseline = baselineResolve();
  if (aiState !== 'done' || !aiResult || !Object.keys(aiOverrides).length) {
    return { r: baseline, baseline, aiApplied: false, aiHeld: false };
  }
  const withAI = resolve(cachedFacts, { ...aiOverrides, ...overrides });
  // Clamp on the FULL state (lane + tier + every §5 condition), not just the lane key:
  // an injectable model could otherwise relax the tier or flip a condition to pass while
  // the lane key stays pinned by a code-certain fact. Any net relaxation is held.
  if (wouldRelax(baseline, withAI)) {
    return { r: baseline, baseline, aiApplied: false, aiHeld: true };   // refuse silent downgrade
  }
  return { r: withAI, baseline, aiApplied: true, aiHeld: false };
}

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

// ---- Pasted-snippet attachments -------------------------------------------
// A paste longer than this many words is too big for the single-line input, so it collapses
// into an attachment chip instead of flooding the field (or auto-analyzing). Anything
// shorter keeps the old "paste a snippet and it just goes" behaviour. The chips can be
// stacked, reviewed, and removed before checking — and a paste can be ~1M lines (the scan
// runs in a Worker, so the page never freezes).
const PASTE_WORD_LIMIT = 100;
let attachments = [];
let attachSeq = 0;

// Count words but bail the instant we pass the limit — so classifying a multi-MB paste as
// "big" costs microseconds (a few hundred chars) instead of tokenizing the whole blob.
function wordsExceed(text, limit) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; if (++n > limit) return true; }
  }
  return false;
}
function countLines(text) { let n = text.length ? 1 : 0; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const CHIP_FILE_ICO = '<svg class="chip-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h6"/></svg>';
const CHIP_X_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function addPasteAttachment(text) {
  const t = String(text || '');
  const att = { id: ++attachSeq, name: guessPasteName(t, `pasted-${attachments.length + 1}`), text: t, lines: countLines(t), bytes: t.length };
  attachments.push(att);
  renderAttachments();
  clearError();
  announce(`Attached ${att.name} — ${att.lines.toLocaleString()} lines`);
}
function removeAttachment(id) { attachments = attachments.filter((a) => a.id !== id); renderAttachments(); }
function renderAttachments() {
  const box = $('#attachments');
  if (!box) return;
  box.innerHTML = attachments.map((a) =>
    `<li class="chip" data-id="${a.id}">${CHIP_FILE_ICO}` +
    `<span class="chip-body"><span class="chip-name" title="${esc(a.name)}">${esc(a.name)}</span>` +
    `<span class="chip-meta">${a.lines.toLocaleString()} lines · ${fmtSize(a.bytes)}</span></span>` +
    `<button class="chip-x" type="button" aria-label="Remove ${esc(a.name)}">${CHIP_X_ICO}</button></li>`,
  ).join('');
  box.hidden = attachments.length === 0;
  syncCheckButton();
}
// Enable "Check it" when there's something to check: a staged snippet, or a valid repo URL.
function syncCheckButton() { $('#analyze').disabled = !(attachments.length || parseGitHubUrl(urlInput.value.trim())); }

$('#attachments').addEventListener('click', (e) => {
  const li = e.target.closest('.chip'); if (!li || !e.target.closest('.chip-x')) return;
  removeAttachment(Number(li.dataset.id));
});

urlInput.addEventListener('input', () => {
  $('#dropzone').classList.toggle('valid', !!parseGitHubUrl(urlInput.value.trim()) && urlInput.value.trim().length > 0);
  syncCheckButton();
  clearError();
});
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#analyze').disabled) startCheck(); });
$('#analyze').addEventListener('click', startCheck);
function startGitHub() { run(() => loadFromGitHub(urlInput.value.trim(), $('#token').value.trim(), setPhase)); }
// Check dispatch: staged pasted snippets win; otherwise it's a GitHub URL.
function startCheck() {
  if (attachments.length) { const items = attachments.map((a) => ({ name: a.name, text: a.text })); run(() => Promise.resolve(loadFromPastes(items))); return; }
  if (parseGitHubUrl(urlInput.value.trim())) startGitHub();
}

// Paste anywhere on the input screen. A paste over the word limit becomes an attachment
// chip (so the field never fills with a wall of code) — regardless of whether a field is
// focused. Below the limit, behaviour is unchanged: inside the url/token field the text
// just types; outside any field a link runs and a short snippet auto-analyzes.
window.addEventListener('paste', (e) => {
  if (card.dataset.state !== 'input') return;
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!text.trim()) return;
  if (wordsExceed(text, PASTE_WORD_LIMIT)) { e.preventDefault(); addPasteAttachment(text); return; }
  const t = e.target;
  if (t && (t.id === 'url' || t.id === 'token')) return; // short paste in a field — let it type
  e.preventDefault();
  const trimmed = text.trim();
  if (parseGitHubUrl(trimmed)) { urlInput.value = trimmed; syncCheckButton(); run(() => loadFromGitHub(trimmed, $('#token').value.trim(), setPhase)); }
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
on('file-input', 'change', (e) => {
  const fl = e.target.files; if (!fl.length) return;
  // A single workbook/CSV goes through the spreadsheet reader (extract the tool inside);
  // anything else (code files, multi-select) takes the normal file-list path.
  if (fl.length === 1 && isSpreadsheet(fl[0].name)) run(() => loadFromSpreadsheet(fl[0], setPhase));
  else run(() => loadFromFileList(fl, setPhase));
});
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
  if (files.length === 1 && isSpreadsheet(files[0].name)) { run(() => loadFromSpreadsheet(files[0], setPhase)); return; }
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

const MIN_DWELL_MS = 1150;      // a considered minimum, so the read never flickers past
const READ_SOFT_CAP_MS = 3600;  // give the read a beat to land so the first answer is usually settled
let revealRun = 0;              // guards the post-reveal settle update against a newer run
let recordedRun = -1;

// Record the read once, when it is final (the read has settled), not twice.
function finalizeRead(run) {
  if (recordedRun === run) return;
  recordedRun = run;
  saveToLibrary(corpus, lastResult);   // persist the check so History/Library can re-open it
}

// ---- Off-thread scan -------------------------------------------------------
// The corpus scan (extractFactsCore) is the one heavy step; on a large paste it can run
// for seconds. We hand it to a Worker so the UI thread — and the "Reading your tool…"
// animation — stays smooth, then rebuild the cheap evOf closure on the main thread with
// hydrateFacts. Everything degrades to a plain synchronous scan if the Worker is
// unavailable for any reason, so the engine's behaviour is identical either way.
let scanWorker = null;
let workerBroken = false;   // once a worker hard-fails, stop trying it for the session
let workerSeq = 0;
function getScanWorker() {
  if (workerBroken) return null;
  if (scanWorker) return scanWorker;
  try {
    scanWorker = new Worker(new URL('./engine/scan-worker.js', import.meta.url), { type: 'module' });
    scanWorker.addEventListener('error', () => { workerBroken = true; try { scanWorker.terminate(); } catch {} scanWorker = null; });
    return scanWorker;
  } catch { workerBroken = true; return null; }
}
function extractFactsViaWorker(corpus) {
  return new Promise((resolveP, rejectP) => {
    const w = getScanWorker();
    if (!w) { rejectP(new Error('no worker')); return; }
    const id = ++workerSeq;
    const cleanup = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
    const onMsg = (e) => {
      if (!e.data || e.data.id !== id) return;   // ignore results from a superseded run
      cleanup();
      if (e.data.ok) resolveP(e.data.core); else rejectP(new Error(e.data.error || 'worker scan failed'));
    };
    const onErr = (err) => { cleanup(); workerBroken = true; rejectP(err); };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    try { w.postMessage({ id, corpus }); } catch (err) { cleanup(); rejectP(err); }
  });
}
async function analyzeFacts(corpus) {
  try {
    return hydrateFacts(await extractFactsViaWorker(corpus));
  } catch {
    return extractFacts(corpus); // synchronous fallback — identical result, just on this thread
  }
}

let busyRun = false;   // guard: ignore a second check while one is already in flight
async function run(loader) {
  if (busyRun) return;   // a double Enter / click / paste must not start a second analysis
  busyRun = true;
  clearError();
  overrides = {};
  setState('analyzing');
  announce('Reading your tool…');
  let i = 0; setPhase(PHASES[0]);
  // Stop the generic rotation once it reaches the last phase so the loaders' granular
  // per-file progress ("Reading files… 7/40") can show through instead of being clobbered.
  const timer = setInterval(() => { i = Math.min(i + 1, PHASES.length - 1); setPhase(PHASES[i]); if (i === PHASES.length - 1) clearInterval(timer); }, 460);
  const minDwell = new Promise((r) => setTimeout(r, MIN_DWELL_MS));
  const myReveal = ++revealRun;
  try {
    const loaded = await loader();
    if (!loaded || !loaded.files || !loaded.files.length) throw new Error('No readable code files were found. Try a different repo, folder, or paste a snippet.');
    corpus = loaded;
    cachedFacts = await analyzeFacts(corpus); // scan once (off-thread for big pastes); what-if toggles reuse this
    // The read works the un-inferable judgments in the background. We hold the
    // reveal a short beat so the first answer is usually already settled; if the
    // read is slower (a local model), we reveal the engine's read now and let the
    // judgment settle into it in place — it never blocks and never hangs.
    const reading = startAdvisor();
    await minDwell;
    await Promise.race([reading, new Promise((r) => setTimeout(r, READ_SOFT_CAP_MS))]);
    clearInterval(timer);
    const settled = aiState !== 'running';
    const reveal = () => { renderResult(); setState('result'); if (settled) finalizeRead(myReveal); };
    if (document.startViewTransition) document.startViewTransition(reveal); else reveal();
    if (!settled) {
      card.dataset.refining = 'on';   // a quiet "still settling" cue (subtle orb pulse)
      reading.then(() => {
        if (revealRun !== myReveal || card.dataset.state !== 'result') return;
        card.removeAttribute('data-refining');
        const upd = () => { renderResult(); if (shell.dataset.dock === 'open') renderDrawer(); };
        if (document.startViewTransition && aiState === 'done') document.startViewTransition(upd); else upd();
        finalizeRead(myReveal);
      });
    }
  } catch (err) {
    clearInterval(timer);
    card.removeAttribute('data-refining');
    setState('input');
    const m = String((err && err.message) || err);
    if (NEEDS_TOKEN.test(m)) $('#token-row').classList.add('open'); // reveal exactly when needed
    showError(friendly(m));
  } finally {
    busyRun = false;   // ready for the next check once this one has revealed (or errored)
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

// A calm one-liner used until (or instead of) the AI's read — so the "Here's what I
// read" card is always present, even with no model available.
function deterministicSummary(r) { return `Looks like ${PATTERN[r.pattern] || 'a small utility'}.`; }

function renderResult() {
  const view = computeView();
  const r = view.r;
  lastView = view;
  lastResult = r;
  const outcome = OUTCOME[r.verdict.key];
  const v = VERDICT[outcome];
  const slug = slugOf(r);
  const pat = PATTERN[r.pattern] || 'a small utility';

  // "Here's what I read" — the AI's plain-language summary of the upload (so the user
  // confirms the app understood it), with a deterministic fallback when no model ran.
  const summaryText = (aiResult && aiResult.summary) ? aiResult.summary : deterministicSummary(r);
  const nFiles = (r.meta && r.meta.fileCount) || 0;
  const summaryCard = `
    <div class="summary"${aiResult && aiResult.summary ? ' data-ai="1"' : ''}>
      <div class="summary-head">${ICONS.sparkles}<span>Here’s what I read</span></div>
      <p class="summary-text">${esc(summaryText)}</p>
      <div class="summary-meta"><span class="slug">${esc(slug)}</span><span class="sdot" aria-hidden="true">·</span>${esc(sourceLabel(r.meta.source))}<span class="sdot" aria-hidden="true">·</span>${nFiles} file${nFiles === 1 ? '' : 's'}<span class="sdot" aria-hidden="true">·</span>looks like ${esc(pat)}</div>
    </div>`;

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

  // One quiet way into the full check. Provenance counts are gone — the read is
  // presented as a single answer — but a low-confidence read still says so.
  const conf = r.confidence || { level: 'high', reasons: [] };
  const confNote = conf.level !== 'high'
    ? `<span class="t-conf t-conf-${conf.level}" title="${esc(conf.reasons.join(' '))}">${conf.level} confidence</span><span class="t-sep">·</span>` : '';
  const seeFull = `<button class="trust" id="trust-line" aria-label="See the full check">${confNote}<span class="t-link">see the full check</span></button>`;

  // FIX-25 — when an automated read judged the tool could be LIGHTER than the
  // code-certain floor, we HOLD it (never auto-apply) and surface it here as a
  // single, plainly-worded, user-confirmable suggestion. The lighter read takes
  // effect only on click — the same manual-confirm path the assumption toggles use.
  let aiHeldBlock = '';
  if (view.aiHeld) {
    const lighter = resolve(cachedFacts, { ...aiOverrides, ...overrides });
    const lighterOutcome = OUTCOME[lighter.verdict.key];
    const lighterLabel = FOOT_VERDICT[lighter.verdict.key] || (VERDICT[lighterOutcome] && VERDICT[lighterOutcome].headline) || 'a lighter read';
    aiHeldBlock = `
    <div class="ai-held" id="ai-held">
      <div>An automated read of the code judged this could be lighter — <b>${esc(lighterLabel)}</b> — rather than <b>${esc(FOOT_VERDICT[r.verdict.key] || v.headline)}</b>. We kept the cautious read; you can apply the lighter one if it’s right.</div>
      <button class="ai-apply" id="ai-apply" type="button">Apply the lighter read</button>
    </div>`;
  }

  $('#result').dataset.outcome = outcome;
  $('#result').innerHTML = `
    <div class="hero">
      <div class="orb" aria-hidden="true"></div>
      <div><h2 class="headline" id="verdict">${esc(v.headline)}</h2></div>
    </div>
    <div class="story">${esc(v.story)}</div>
    ${summaryCard}
    ${seeFull}

    <div class="reasons-eyebrow">${drivers.length && outcome !== 'ready' ? 'Here’s what decided it' : 'The all-clear'}</div>
    <div class="tiles">${tiles}</div>
    ${lightenPill}

    <div class="action">
      <button class="ghost walk" id="walk"><span class="play">${ICONS.play}</span> Walk me through it</button>
      <div class="spacer"></div>
      <button class="cta" id="cta">${esc(v.cta)}</button>
    </div>
    ${aiHeldBlock}`;

  announce(`${v.headline} ${v.story}`);
  updateFooter(r);
  if (shell.dataset.dock === 'open') renderDrawer();   // keep an open dock in sync with the verdict

  $('#trust-line').addEventListener('click', openDrawer);
  $('#cta').addEventListener('click', () => copyHandoff(r, v));
  $('#walk').addEventListener('click', () => startWalkthrough(r));
  const lb = $('#lighten-btn'); if (lb) lb.addEventListener('click', openLighten);
  // FIX-25 — the held lighter read only applies on this explicit click; merging
  // aiOverrides into the user's own overrides is the same manual-confirm seam the
  // assumption toggles use (setOverride), so the clamp now sees a human choice.
  const ah = $('#ai-apply');
  if (ah) ah.addEventListener('click', () => { Object.assign(overrides, aiOverrides); renderResult(); });
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

// The privacy line — never names a model. Cloud-only: the code is sent to the
// hosted reader to be read (and we don't over-claim what happens to it there).
function privacyLine() {
  return 'Read-only · your code is only ever read, never changed.';
}

// Map the judged read's suggestions onto the engine's override keys. The model's
// vocabulary lines up with the engine's, except: writeAuthority "none" collapses
// to "scratch" (both = not a system of record), and humanReview is a boolean.
// humanReview is only applied when logic is probabilistic (Yellow) — on a
// deterministic tool it can't change the verdict and is the model's weakest field.
function mapAiToOverrides(res) {
  const o = {};
  const s = res.suggestions || {};
  if (s.dataScope) o.dataScope = s.dataScope.value;
  if (s.reliance) o.reliance = s.reliance.value;
  if (s.writeAuthority) o.writeAuthority = s.writeAuthority.value === 'authoritative' ? 'authoritative' : 'scratch';
  if (s.humanReview && cachedFacts && cachedFacts.facts.probabilistic) o.humanReview = s.humanReview.value === 'yes';
  return o;
}

// Read the four un-inferable judgments from the actual code, in the background.
// Always attempts (the server routes to a local model, or the hosted reader as a
// silent fallback); if nothing answers it just leaves the engine's read in place.
// Sets aiState and the judged overrides, but does NOT render — run() owns the
// reveal timing. Resolves when the read settles (or can't run); never throws.
function startAdvisor() {
  if (!corpus) { aiState = 'off'; return Promise.resolve(); }
  if (aiAbort) aiAbort.abort();
  const myRun = ++aiRunId;
  aiAbort = new AbortController();
  aiState = 'running'; aiResult = null; aiOverrides = {};
  return runAdvisor(corpus, { model: DEFAULT_MODEL, signal: aiAbort.signal })
    .catch(() => ({ ok: false }))
    .then((res) => {
      if (myRun !== aiRunId) return;          // a newer run (or reset) superseded this one
      if (res && res.ok) { aiResult = res; aiOverrides = mapAiToOverrides(res); aiState = 'done'; }
      else { aiState = 'failed'; }
    });
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
  // Inert every region a Tab could reach behind the modal. The overlay is appended
  // to #work as a sibling of #card, so inerting #card (the verdict content) does not
  // inert the overlay itself. close() iterates this same set, so it stays symmetric.
  const washed = document.querySelectorAll('.rail, .toolhead, .dock, .foot, #card, .sidebar, .bottompanel');
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
// Every region behind the dock when it falls back to a narrow-screen overlay —
// the dock itself is excluded so it stays interactive. open/closeDrawer apply and
// remove inert over the SAME set so focus can't escape (and isn't stranded).
const dockBehind = () => document.querySelectorAll('.rail, .toolhead, .foot, #card, .sidebar, .bottompanel');
function openDrawer() {
  if (shell.dataset.dock !== 'open') { renderDrawer(); drawerReturnFocus = document.activeElement; }
  shell.dataset.dock = 'open';
  syncPanelBtn('dock', true); store.set('panel.dock', true);
  $('#dock-toggle')?.setAttribute('aria-expanded', 'true');
  if (isNarrow()) {
    // narrow: the dock is a fixed scrim overlay — make it a real modal and trap focus
    const dock = $('#dock');
    if (dock) { dock.setAttribute('role', 'dialog'); dock.setAttribute('aria-modal', 'true'); }
    dockBehind().forEach((el) => el.setAttribute('inert', ''));
    $('#drawer-close').focus();
  }
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
  // tear down the narrow-screen modal semantics + inert, regardless of current width
  // (the viewport may have changed since open) so nothing is left inert or trapped
  const dock = $('#dock');
  if (dock) { dock.removeAttribute('role'); dock.removeAttribute('aria-modal'); }
  dockBehind().forEach((el) => el.removeAttribute('inert'));
  if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
}
// scrim sits behind whichever overlay is open on narrow screens — close them
$('#scrim')?.addEventListener('click', () => { closeDrawer(); setSidebar(false); });
$('#drawer-close').addEventListener('click', closeDrawer);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (setOverlay && !setOverlay.hidden) { closeSettings(); return; }
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
  const conf = r.confidence || { level: 'high', reasons: [] };
  const confBlock = conf.level !== 'high'
    ? `<div class="cert-block"><span class="cert-conf cert-conf-${conf.level}">${conf.level} confidence — ${esc(conf.reasons[0] || '')}</span></div>` : '';
  const lighten = (r.lighten || []);
  const lightenBlock = lighten.length ? `
    <div class="lighten-block">
      <div class="lb-head"><span class="bolt">${ICONS.bolt}</span> What would make it lighter</div>
      ${lighten.map((l) => `<div class="lb-item">${esc(l.text)} ${l.wouldBe ? `<span class="lb-would">→ ${esc(WOULDBE[l.wouldBe] || 'lighter')}</span>` : ''}</div>`).join('')}
    </div>` : '';
  $('#drawer-body').innerHTML = `
    <p style="font-size:13px;color:var(--muted);line-height:1.5;margin:10px 0 6px">
      ${esc(v.headline)} Every check below in plain words — adjust anything we had to assume and the read updates.
    </p>
    ${confBlock}
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

// An adjustable assumption row: the question + the choices, with the current read
// selected. Presented as the app's own read — no model attribution, no badges.
// Changing a value is the user's call and re-resolves the verdict instantly.
function assumeHTML(a) {
  const opts = a.options.map((o) => `<button type="button" role="radio" aria-checked="${o.value === a.value ? 'true' : 'false'}" data-kind="${esc(a.kind)}" data-val="${esc(o.value)}" class="${o.value === a.value ? 'on' : ''}">${esc(o.label)}</button>`).join('');
  return `<div class="assume"><span class="q">${esc(QLABEL[a.kind] || 'Assumed')}</span><span class="seg" role="radiogroup" aria-label="${esc(QLABEL[a.kind] || 'Assumption')}">${opts}</span></div>`;
}

// ============================================================================
function reset() {
  if (currentWalkClose) currentWalkClose(); else document.querySelector('.walk-overlay')?.remove();
  try { window.speechSynthesis.cancel(); } catch {}
  closeDrawer();
  if (aiAbort) aiAbort.abort();
  aiRunId++; aiState = 'off'; aiResult = null; aiOverrides = {};
  corpus = null; cachedFacts = null; overrides = {}; lastResult = null;
  setState('input');
  resetFooter();
  urlInput.value = ''; $('#analyze').disabled = true;
  attachments = []; renderAttachments();
  $('#dropzone').classList.remove('valid');
  $('#token-row').classList.remove('open');
  clearError();
  urlInput.focus();
}

// ============================================================================
//  Shell — activity rail (tool registry), header options, theme, status footer
// ============================================================================

// The extensibility contract: one entry per tool (a rail icon + a canvas view +
// optional dock/footer hooks). Adding a tool = one row here. Validator is the main
// canvas; History and Docs aren't separate canvases — they open the panel that already
// holds that content (the recents sidebar = your history; the bottom Lanes reference =
// the docs), so the rail icons are live toggles rather than dead "coming soon" links.
const TOOLS = [
  { id: 'validator', label: 'Validator', enabled: true, icon: '<circle cx="11" cy="11" r="7"/><path d="M16 16l4.5 4.5"/>' },
  { id: 'history', label: 'History', enabled: true, panel: 'side', icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  { id: 'library', label: 'Library', enabled: true, icon: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>' },
  { id: 'docs', label: 'Docs', enabled: true, panel: 'bottom', icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h5"/>' },
];

function renderRail() {
  const host = $('#rail-tools'); if (!host) return;
  host.innerHTML = TOOLS.map((t) => {
    const active = t.id === shell.dataset.tool;
    // Panel tools (History/Docs) reflect their panel's open state instead of "current page".
    const open = t.panel === 'side' ? shell.dataset.side === 'open' : t.panel === 'bottom' ? shell.dataset.bottom === 'open' : false;
    const state = t.panel ? `aria-pressed="${open}"` : (active ? 'aria-current="page"' : '');
    return `<button class="rail-btn${t.enabled ? '' : ' dormant'}" type="button" role="listitem" data-tool="${t.id}"
        ${t.enabled ? '' : 'disabled tabindex="-1"'} ${state}
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
  // History/Docs toggle their panel (recents = history, lanes reference = docs); the main
  // canvas stays on the Validator. Only a true canvas tool switches shell.dataset.tool.
  if (t.panel === 'side') { setSidebar(shell.dataset.side !== 'open'); return; }
  if (t.panel === 'bottom') { setBottom(shell.dataset.bottom !== 'open'); return; }
  shell.dataset.tool = id;
  $('#th-name').textContent = t.label;
  renderRail();
  if (id === 'library') loadLibrary();
}

// ---- theme (Auto / Light / Dark), remembered -------------------------------
function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  store.set('theme', mode);
  // every theme segment on the page (header quick-menu + settings page) stays in sync
  document.querySelectorAll('.theme-seg button').forEach((b) => {
    const on = b.dataset.theme === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

// ============================================================================
//  Settings — a full overlay with a section sidebar. One registry row per
//  section; each renders its own pane. The header quick-menu and this page share
//  the SAME theme controls (class-based sync in applyTheme), so the two never
//  drift. Adding a section = one row in SETTINGS_SECTIONS.
// ============================================================================
const APP_VERSION = '1.0.0';

const SET_ICON = {
  account: '<circle cx="12" cy="8.2" r="3.6"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6"/>',
  intelligence: '<path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L7 11l5.2-1.8z"/><path d="M18 4.5l.6 1.7 1.7.6-1.7.6L18 9.6l-.6-1.7L15.7 7.3l1.7-.6z"/>',
  privacy: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5v5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
};

const SETTINGS_SECTIONS = [
  ...(cloudConfigured() ? [{ id: 'account', label: 'Account', render: renderSetAccount }] : []),
  { id: 'appearance',   label: 'Appearance',      render: renderSetAppearance },
  { id: 'intelligence', label: 'Intelligence',    render: renderSetAI },
  { id: 'privacy',      label: 'Privacy & data',  render: renderSetPrivacy },
  { id: 'about',        label: 'About',           render: renderSetAbout },
];

let setOverlay = null;        // the lazily-built overlay element (reused)
let setReturnFocus = null;    // element to restore focus to on close
let setActive = 'appearance'; // remembered section across opens
let aiRechecking = false;     // transient: re-pinging the reader for a live status
let authBusy = false;         // transient: a sign-in / sign-up request is in flight
let authMsg = null;           // {kind:'error'|'ok', text} feedback under the form
let authEmail = '';           // preserve the typed email across a re-render

function buildSettings() {
  const ov = document.createElement('div');
  ov.className = 'set-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Settings');
  ov.hidden = true;
  ov.innerHTML = `
    <div class="set-window">
      <header class="set-top">
        <span class="set-title">Settings</span>
        <button class="set-x" type="button" aria-label="Close settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="set-main">
        <nav class="set-nav" aria-label="Settings sections">${SETTINGS_SECTIONS.map((s) => `
          <button class="set-navitem" type="button" data-sec="${s.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${SET_ICON[s.id]}</svg>
            <span>${esc(s.label)}</span>
          </button>`).join('')}
        </nav>
        <div class="set-content" id="set-content" tabindex="-1"></div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  ov.addEventListener('click', (e) => { if (e.target === ov) closeSettings(); });        // backdrop
  ov.querySelector('.set-x').addEventListener('click', closeSettings);
  ov.querySelector('.set-nav').addEventListener('click', (e) => {
    const b = e.target.closest('.set-navitem'); if (b) selectSettings(b.dataset.sec);
  });
  // delegated controls live inside the re-rendered content pane
  ov.querySelector('.set-content').addEventListener('click', (e) => {
    // scope to the seg buttons — a bare [data-theme] would also match <html>, which
    // carries data-theme when a theme is locked, swallowing every other click here
    const themeBtn = e.target.closest('button[data-theme]');
    if (themeBtn) { applyTheme(themeBtn.dataset.theme); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'clear-recents') { clearAll(); }
    else if (act === 'toggle-save') { store.set('save', !savingEnabled()); renderSettingsBody(); }
    else if (act === 'open-playbook') { closeSettings(); setBottom(true); }
    else if (act === 'recheck-ai') recheckAI();
    else if (act === 'sign-in' || act === 'sign-up') doAuth(act);
    else if (act === 'sign-out') doSignOut();
  });
  return ov;
}

function openSettings() {
  if (!setOverlay) setOverlay = buildSettings();
  setReturnFocus = document.activeElement;
  setOverlay.hidden = false;
  shell.setAttribute('inert', '');     // park the app behind the modal
  renderSettingsBody();
  if (setActive === 'intelligence') recheckAI();   // confirm the reader is live, this moment
  requestAnimationFrame(() => setOverlay.querySelector(`.set-navitem[data-sec="${setActive}"]`)?.focus());
}
function closeSettings() {
  if (!setOverlay || setOverlay.hidden) return;
  setOverlay.hidden = true;
  shell.removeAttribute('inert');
  if (setReturnFocus && setReturnFocus.focus) setReturnFocus.focus();
}
function selectSettings(id) {
  if (!SETTINGS_SECTIONS.some((s) => s.id === id)) return;
  setActive = id;
  renderSettingsBody();
  setOverlay?.querySelector('#set-content')?.focus();
  if (id === 'intelligence') recheckAI();   // confirm the reader is live, this moment
}
function renderSettingsBody() {
  if (!setOverlay) return;
  setOverlay.querySelectorAll('.set-navitem').forEach((b) => {
    const on = b.dataset.sec === setActive;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const sec = SETTINGS_SECTIONS.find((s) => s.id === setActive) || SETTINGS_SECTIONS[0];
  const host = setOverlay.querySelector('#set-content');
  host.innerHTML = sec.render();
  host.scrollTop = 0;
  // re-sync the shared controls so the freshly rendered pane reflects live state
  applyTheme(store.get('theme', 'auto'));
}

// ---- Account — optional cloud sign-in --------------------------------------
// Lane works fully without an account (everything stays on this device). Signing
// in turns on cloud sync: your check history and saved files follow you across
// devices, walled off to your account by row-level security on the server.
function renderSetAccount() {
  const u = currentUser();
  const msg = authMsg
    ? `<p class="set-foot ${authMsg.kind === 'error' ? 'set-foot-err' : ''}">${esc(authMsg.text)}</p>` : '';
  if (u) {
    return `
    <div class="set-pane">
      <h3 class="set-h">Account</h3>
      <p class="set-sub">You're signed in. Your check history and saved files sync to your account.</p>
      <div class="set-card">
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Signed in</div>
            <div class="set-rd">${esc(u.email || 'your account')}</div>
          </div>
          <span class="set-status live"><span class="sdot" aria-hidden="true"></span>Synced</span>
        </div>
        <div class="set-row set-row-foot">
          <button class="set-btn" type="button" data-act="sign-out" ${authBusy ? 'disabled' : ''}>${authBusy ? 'Signing out…' : 'Sign out'}</button>
        </div>
      </div>
      ${msg}
      <p class="set-foot">Sign out and Lane goes back to keeping everything on this device only.</p>
    </div>`;
  }
  return `
    <div class="set-pane">
      <h3 class="set-h">Account</h3>
      <p class="set-sub">Optional. Sign in to sync your history and saved files across devices. Without an account, everything stays on this device.</p>
      <div class="set-card">
        <div class="set-field">
          <label class="set-rt" for="auth-email">Email</label>
          <input class="set-input" type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" value="${esc(authEmail)}" ${authBusy ? 'disabled' : ''} />
        </div>
        <div class="set-field">
          <label class="set-rt" for="auth-pass">Password</label>
          <input class="set-input" type="password" id="auth-pass" autocomplete="current-password" placeholder="••••••••" ${authBusy ? 'disabled' : ''} />
        </div>
        <div class="set-row set-row-foot set-row-auth">
          <button class="set-btn primary" type="button" data-act="sign-in" ${authBusy ? 'disabled' : ''}>${authBusy ? 'Working…' : 'Sign in'}</button>
          <button class="set-btn" type="button" data-act="sign-up" ${authBusy ? 'disabled' : ''}>Create account</button>
        </div>
      </div>
      ${msg}
      <p class="set-foot">Your code is still only ever read, never changed. Saving syncs your file and its result to your private account — nothing is shared with anyone else.</p>
    </div>`;
}

// Run a sign-in or sign-up from the Account pane, then reflect the new state.
async function doAuth(kind) {
  if (authBusy) return;
  const emailEl = setOverlay?.querySelector('#auth-email');
  const passEl = setOverlay?.querySelector('#auth-pass');
  const email = (emailEl?.value || '').trim();
  const password = passEl?.value || '';
  authEmail = email;
  if (!email || !password) { authMsg = { kind: 'error', text: 'Enter an email and password.' }; renderSettingsBody(); return; }
  authBusy = true; authMsg = null; renderSettingsBody();
  try {
    if (kind === 'sign-up') {
      const { needsConfirm } = await signUp(email, password);
      if (needsConfirm) authMsg = { kind: 'ok', text: 'Account created — check your email to confirm, then sign in.' };
    } else {
      await signIn(email, password);
    }
  } catch (e) {
    authMsg = { kind: 'error', text: friendlyAuthError(e) };
  }
  authBusy = false;
  if (isSignedIn()) { authEmail = ''; authMsg = null; }
  syncAvatar();
  renderSettingsBody();
  await loadLibrary();          // pull this account's saved checks (or fall back to local)
}

async function doSignOut() {
  if (authBusy) return;
  authBusy = true; renderSettingsBody();
  try { await signOut(); } catch {}
  authBusy = false; authMsg = null;
  renderSettingsBody();
  syncAvatar();
  await loadLibrary();
}

function friendlyAuthError(e) {
  const m = String(e?.message || e || '').toLowerCase();
  if (e?.status === 429 || m.includes('rate limit') || m.includes('too many')) return 'Too many attempts — wait a minute and try again.';
  if (m.includes('not confirmed')) return 'Check your email to confirm this account, then sign in.';
  if (m.includes('invalid login') || m.includes('invalid credentials')) return 'That email and password don\'t match.';
  if (m.includes('already registered') || m.includes('already exists')) return 'That email already has an account — try signing in.';
  if (m.includes('invalid') && m.includes('email')) return 'That doesn\'t look like a valid email.';
  if (m.includes('password')) return 'Password must be at least 6 characters.';
  return e?.message || 'Something went wrong. Try again.';
}

// Reflect signed-in state on the rail avatar (a small dot) and its tooltip.
function syncAvatar() {
  const btn = $('#account-btn'); if (!btn) return;
  const u = currentUser();
  btn.dataset.signed = u ? 'true' : 'false';
  btn.setAttribute('aria-label', u ? `Account · ${u.email || 'signed in'}` : 'Account · sign in');
  const tip = btn.querySelector('.tip');
  if (tip) tip.textContent = u ? (u.email || 'Account') : 'Account';
}

// The avatar opens Settings on the Account section (sign-in form or signed-in state).
function openAccount() {
  if (!cloudConfigured()) { openSettings(); return; }
  setActive = 'account';
  openSettings();
}

function renderSetAppearance() {
  return `
    <div class="set-pane">
      <h3 class="set-h">Appearance</h3>
      <p class="set-sub">How Lane looks on this device. Remembered in this browser only.</p>
      <div class="set-card">
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Theme</div>
            <div class="set-rd">Follow your system, or lock to light or dark.</div>
          </div>
          <div class="seg theme-seg" role="radiogroup" aria-label="Theme">
            <button type="button" role="radio" data-theme="auto">Auto</button>
            <button type="button" role="radio" data-theme="light">Light</button>
            <button type="button" role="radio" data-theme="dark">Dark</button>
          </div>
        </div>
      </div>
    </div>`;
}

// ---- Intelligence — the live status of the model that reads the code --------
// Settings is the one place the model is named: a curious user can confirm it's
// reachable and working, without the read ever being marketed in the main flow.
// Everything here is derived from the real /api/llm/health probe (aiAvailable),
// so "Live" means a reader actually answered — not a hard-coded label.

// Turn a backend model id into a calm, human label. The local key is reliable;
// hosted ids vary, so we map the ones we ship and fall back to a clean generic.
function prettyModel(id) {
  if (!id) return '';
  const s = String(id).toLowerCase();
  if (s.includes('gemma')) return 'Gemma (4B)';
  if (s.includes('llama-3.3-70b') || s.includes('llama3.3')) return 'Llama 3.3 (70B)';
  if (s.includes('llama-4-scout')) return 'Llama 4 Scout';
  if (s.includes('mistral')) return 'Mistral Small (24B)';
  if (s.includes('qwen')) return 'Qwen 2.5 Coder (32B)';
  return id.replace(/^@?[^/]+\//, '').replace(/:.*/, '').replace(/[-_]/g, ' ').trim();
}

// One presentation object for the Intelligence pane, read off aiAvailable.
// Cloud-only: every read runs on the hosted Cloudflare reader, so `live` just
// means that reader answered the health probe. `provider` is 'cloud' (local dev
// server) or 'cloudflare' (deployed app) — both the same hosted reader.
function aiStatusModel() {
  const provider = aiAvailable && aiAvailable.provider;   // 'cloud' | 'cloudflare' | null
  const live = !!provider;                                // the hosted reader answered
  let statusClass, statusLabel, statusDesc;
  if (aiRechecking) {
    statusClass = 'checking'; statusLabel = 'Checking…';
    statusDesc = 'Reaching the model to confirm it answers.';
  } else if (live) {
    statusClass = 'live'; statusLabel = 'Live';
    statusDesc = 'The cloud reader answered just now — ready to read your code.';
  } else {
    statusClass = 'off'; statusLabel = 'Rules only';
    statusDesc = 'The cloud reader isn’t answering right now. Checks still run in full on the built-in rules.';
  }
  const whereLabel = live ? 'Cloud' : 'Built-in rules';
  const whereDesc = live
    ? 'Your code is sent to a hosted model to be read once, then discarded — never stored or changed.'
    : 'The deterministic rules run entirely in your browser.';
  const rawModel = aiAvailable && aiAvailable.model;
  const pretty = esc(prettyModel(rawModel));
  const namedModel = pretty && pretty !== 'Gemma (4B)' && !/cloudflare/i.test(String(rawModel || ''));
  let modelDesc;
  if (live) modelDesc = namedModel
    ? `${pretty} · served on Cloudflare Workers AI.`
    : 'A hosted open model, served on Cloudflare Workers AI.';
  else modelDesc = 'No model answering — the rules engine decides on its own.';
  return { statusClass, statusLabel, statusDesc, whereLabel, whereDesc, modelDesc };
}

function renderSetAI() {
  const a = aiStatusModel();
  return `
    <div class="set-pane">
      <h3 class="set-h">Intelligence</h3>
      <p class="set-sub">Lane reads your code with a small AI model. Here's what it's using and whether it's live right now — the built-in rules always make the final call.</p>
      <div class="set-card">
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Status</div>
            <div class="set-rd">${a.statusDesc}</div>
          </div>
          <span class="set-status ${a.statusClass}"><span class="sdot" aria-hidden="true"></span>${esc(a.statusLabel)}</span>
        </div>
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Where it runs</div>
            <div class="set-rd">${a.whereDesc}</div>
          </div>
          <span class="set-badge alt">${esc(a.whereLabel)}</span>
        </div>
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Model</div>
            <div class="set-rd">${a.modelDesc}</div>
          </div>
        </div>
        <div class="set-row set-row-foot">
          <button class="set-btn" type="button" data-act="recheck-ai" ${aiRechecking ? 'disabled' : ''}>${aiRechecking ? 'Checking…' : 'Check again'}</button>
        </div>
      </div>
      <p class="set-foot">However it reads, the built-in rules make the call. The model only fills in judgment the code can't show on its own — and it can add caution, never remove it.</p>
    </div>`;
}

// Re-ping the reader so the Intelligence pane shows a live, this-moment status.
// Shared with the privacy line (which also phrases itself by where the read runs).
async function recheckAI() {
  if (aiRechecking) return;
  aiRechecking = true;
  if (setOverlay && !setOverlay.hidden && setActive === 'intelligence') renderSettingsBody();
  try { aiAvailable = await checkAvailable(); } catch { aiAvailable = null; }
  aiRechecking = false;
  if (card.dataset.state === 'input') resetFooter();   // refresh the idle privacy line
  if (setOverlay && !setOverlay.hidden && (setActive === 'intelligence' || setActive === 'privacy')) renderSettingsBody();
}

function renderSetPrivacy() {
  const n = libraryCache.length;
  const signedIn = isSignedIn();
  const saving = savingEnabled();
  const where = signedIn ? 'in your account' : 'on this device';
  return `
    <div class="set-pane">
      <h3 class="set-h">Privacy &amp; data</h3>
      <p class="set-sub">Your code is only ever READ to score it — never changed. ${saving ? `Each check is saved to your Library ${where}${signedIn ? ', synced to your private account' : ' (on this device unless you sign in)'} so you can re-open it.` : 'Saving is off — checks run without storing anything.'}</p>
      <div class="set-card">
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Read-only</div>
            <div class="set-rd">Lane never modifies your code — it only reads it to produce the verdict.</div>
          </div>
          <span class="set-badge">Read-only</span>
        </div>
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Save my checks</div>
            <div class="set-rd">${saving ? `Keeps a History &amp; Library you can re-open${signedIn ? ', synced to your account' : ' — stored only on this device'}. Up to ${MAX_LIBRARY} most-recent are kept.` : 'Off — nothing is stored; your code never leaves this page.'}</div>
          </div>
          <button class="set-switch${saving ? ' on' : ''}" type="button" role="switch" aria-checked="${saving}" data-act="toggle-save" aria-label="Save my checks"><span class="set-switch-dot"></span></button>
        </div>
        <div class="set-row">
          <div class="set-rl">
            <div class="set-rt">Saved checks</div>
            <div class="set-rd">${n ? `${n} check${n === 1 ? '' : 's'} saved ${where}.` : 'Nothing saved yet.'}</div>
          </div>
          <button class="set-btn danger" type="button" data-act="clear-recents" ${n ? '' : 'disabled'}>Clear all</button>
        </div>
      </div>
    </div>`;
}

function renderSetAbout() {
  return `
    <div class="set-pane">
      <h3 class="set-h">About</h3>
      <p class="set-sub">A quick read on where a proof-of-concept should be hosted, and why.</p>
      <div class="set-card set-about">
        <span class="set-about-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32"><g fill="currentColor"><rect x="8" y="17" width="3.4" height="7" rx="1.5"/><rect x="14.3" y="12" width="3.4" height="12" rx="1.5"/><rect x="20.6" y="8" width="3.4" height="16" rx="1.5"/></g></svg>
        </span>
        <div class="set-about-tx">
          <div class="set-rt">Lane — POC Validator</div>
          <div class="set-rd">A deterministic rules engine triages a POC into Lane 1, Lane 2, or sign-off, straight from its code.</div>
        </div>
        <span class="set-ver">v${esc(APP_VERSION)}</span>
      </div>
      <div class="set-card">
        <button class="set-row set-row-link" type="button" data-act="open-playbook">
          <div class="set-rl">
            <div class="set-rt">POC triage &amp; hosting playbook</div>
            <div class="set-rd">The lanes, and what pushes a tool heavier.</div>
          </div>
          <svg class="set-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <p class="set-foot">A quick read, not the final word — your AI operations lead makes the hosting call.</p>
    </div>`;
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
  fv.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span class="foot-txt">${esc(privacyLine())}</span>`;
  $('#foot-conf').textContent = '';
}

// ---- the Library — the single store of saved checks (History + Library tool) ----
// Every checked tool is saved here as an asset (its corpus + last verdict) so it can be
// re-opened later. Signed in -> the user's Supabase Storage; signed out -> IndexedDB on
// this device (src/library/store.js routes it). `libraryCache` mirrors the store so the
// sidebar and grid render synchronously; loadLibrary() refreshes it.
let libraryCache = [];
let skipNextSave = false;   // set while re-opening a saved check, so it isn't re-saved

async function loadLibrary() {
  try { libraryCache = await listAssets(); } catch { libraryCache = []; }
  renderSidebar();
  if (shell.dataset.tool === 'library') renderLibrary();
  if (setOverlay && !setOverlay.hidden && setActive === 'privacy') renderSettingsBody();
}

// Data handling (best practice): saving is user-controllable and bounded. The Privacy
// toggle `lane.save` (default on) gates ALL persistence — off means a check runs and is
// never stored anywhere (your code never leaves the page). When on, it goes to this device
// (IndexedDB) or your account (Supabase Storage, owner-only RLS) if signed in. We keep at
// most MAX_LIBRARY recent checks (data minimization) so source can't accumulate unbounded.
const MAX_LIBRARY = 50;
const savingEnabled = () => store.get('save', true);

// Persist the just-finished check (called once from finalizeRead). The corpus (code +
// metadata + verdict) is stored as a JSON blob so it can be re-run; a re-open of an
// already-saved check is skipped so it doesn't duplicate.
async function saveToLibrary(corpus, result) {
  if (!corpus || !result) return;
  if (skipNextSave) { skipNextSave = false; return; }
  if (!savingEnabled()) return;   // user turned saving off — nothing is stored
  try {
    const id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `a-${Math.floor(performance.now())}-${libraryCache.length}`;
    const payload = { source: corpus.source, label: corpus.label, files: corpus.files, meta: corpus.meta, verdict: result.verdict.key, savedAt: Date.now() };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    await putAsset({
      id, createdAt: Date.now(), name: corpus.label || slugOf(result) || 'Check',
      source: corpus.source, verdict: result.verdict.key, fileCount: (corpus.files || []).length,
      type: 'application/lane-corpus', size: blob.size, blob,
    });
    await loadLibrary();
    // retention cap — prune the oldest beyond MAX_LIBRARY (libraryCache is newest-first).
    const extras = libraryCache.slice(MAX_LIBRARY);
    if (extras.length) { for (const a of extras) { try { await deleteAsset(a.id); } catch {} } await loadLibrary(); }
  } catch { /* storage unavailable (private mode / quota) — degrade quietly */ }
}

// Re-open a saved check: load its corpus and run the pipeline again (no re-save).
async function reopenAsset(id) {
  let a; try { a = await getAsset(id); } catch { a = null; }
  if (!a || !a.blob) return;
  let p; try { p = JSON.parse(await a.blob.text()); } catch { return; }
  setSidebar(false);
  if (shell.dataset.tool !== 'validator') { shell.dataset.tool = 'validator'; $('#th-name').textContent = 'Validator'; renderRail(); }
  skipNextSave = true;
  run(() => Promise.resolve({ source: p.source || 'upload', label: p.label || a.name || 'Check', files: p.files || [], meta: p.meta || {}, notes: [] }));
}

// Download a saved check: the original file if it was a single file, else a JSON bundle.
async function downloadAsset(id) {
  let a; try { a = await getAsset(id); } catch { a = null; }
  if (!a || !a.blob) return;
  let p = null; try { p = JSON.parse(await a.blob.text()); } catch { /* leave p null */ }
  let outBlob, outName;
  if (p && Array.isArray(p.files) && p.files.length === 1) {
    outBlob = new Blob([p.files[0].text || ''], { type: 'text/plain' });
    outName = (p.files[0].path || a.name || 'file').split('/').pop();
  } else if (p) {
    outBlob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    outName = `${String(a.name || 'check').replace(/[^\w.-]+/g, '_')}.lane.json`;
  } else { outBlob = a.blob; outName = a.name || 'asset'; }
  const url = URL.createObjectURL(outBlob);
  const link = document.createElement('a'); link.href = url; link.download = outName;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function removeAsset(id) {
  try { await deleteAsset(id); } catch {}
  await loadLibrary();
}

async function clearAll() {
  try { await clearAssets(); } catch {}
  try { if (isSignedIn()) await clearChecks(); } catch {}   // also wipe any legacy audit rows
  store.set('recents', []);
  libraryCache = [];
  renderSidebar();
  if (shell.dataset.tool === 'library') renderLibrary();
  if (setOverlay && !setOverlay.hidden) renderSettingsBody();
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
  renderRail();   // keep the rail History toggle's pressed state in sync
}
function setBottom(open) {
  shell.dataset.bottom = open ? 'open' : 'closed';
  syncPanelBtn('bottom', open); store.set('panel.bottom', open);
  renderRail();   // keep the rail Docs toggle's pressed state in sync
}

const RECENT_LABEL = { lane1: 'Ready to host', lane2: 'Hand to a developer', approve: 'Needs a sign-off' };
const VERDICT_SHORT = { lane1: 'Lane 1', lane2: 'Lane 2', approve: 'Approve' };
const SOURCE_LABEL = { github: 'GitHub', upload: 'Upload', zip: 'Zip', paste: 'Paste', spreadsheet: 'Workbook' };
const sourceLabel = (s) => SOURCE_LABEL[s] || 'Check';
function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

// History sidebar — saved checks, newest first, each re-openable (click).
function renderSidebar() {
  const host = $('#side-body'); if (!host) return;
  const list = libraryCache;
  if (!list.length) {
    host.innerHTML = `<div class="side-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
      <div>Your checked tools will show up here.</div>
    </div>`;
    return;
  }
  host.innerHTML = list.map((a) => `<div class="recent" role="button" tabindex="0" data-id="${esc(a.id)}" data-v="${esc(a.verdict || '')}" title="Re-open this check">
      <span class="rdot" aria-hidden="true"></span>
      <span class="rtx"><span class="rslug">${esc(a.name || 'Check')}</span><span class="rmeta">${esc(a.verdict ? (RECENT_LABEL[a.verdict] || '') : sourceLabel(a.source))}${a.createdAt ? ` · ${esc(relTime(a.createdAt))}` : ''}</span></span>
    </div>`).join('')
    + `<button class="side-clear" id="side-clear" type="button">Clear history</button>`;
}

// Library tool — full-canvas grid of saved checks with re-check / download / remove.
function renderLibrary() {
  const grid = $('#lib-grid'); if (!grid) return;
  const q = ($('#lib-search')?.value || '').trim().toLowerCase();
  const items = libraryCache.filter((a) => !q || (a.name || '').toLowerCase().includes(q));
  if (!items.length) {
    grid.innerHTML = `<div class="lib-empty">${q ? 'No saved checks match your search.' : 'Nothing saved yet — run a check and it’ll appear here.'}</div>`;
    return;
  }
  grid.innerHTML = items.map((a) => `<div class="lib-card" data-id="${esc(a.id)}">
      <div class="lib-card-head">
        <span class="lib-name" title="${esc(a.name || 'Check')}">${esc(a.name || 'Check')}</span>
        ${a.verdict ? `<span class="lib-badge" data-v="${esc(a.verdict)}">${esc(VERDICT_SHORT[a.verdict] || '')}</span>` : ''}
      </div>
      <div class="lib-meta">${esc(sourceLabel(a.source))}${a.fileCount ? ` · ${a.fileCount} file${a.fileCount === 1 ? '' : 's'}` : ''}${a.createdAt ? ` · ${esc(relTime(a.createdAt))}` : ''}</div>
      <div class="lib-actions">
        <button class="lib-act" type="button" data-act="recheck" data-id="${esc(a.id)}">Re-check</button>
        <button class="lib-act" type="button" data-act="download" data-id="${esc(a.id)}">Download</button>
        <button class="lib-act danger" type="button" data-act="remove" data-id="${esc(a.id)}">Remove</button>
      </div>
    </div>`).join('');
}

// Learn where the read will run (local vs hosted) so the privacy line can be
// phrased honestly. Purely informational — nothing gates on it; the read always
// runs, and the server routes to whatever backend is reachable. Never throws.
async function initRead() {
  try { aiAvailable = await checkAvailable(); } catch { aiAvailable = null; }
  if (card.dataset.state === 'input') resetFooter();   // refresh the idle privacy line
  if (setOverlay && !setOverlay.hidden && (setActive === 'intelligence' || setActive === 'privacy')) renderSettingsBody();
}

// ---- wire the shell once ---------------------------------------------------
function initShell() {
  renderRail();
  applyTheme(store.get('theme', 'auto'));
  resetFooter();

  // The account icon is the single entry to the full Settings overlay (which
  // carries Appearance/theme, Intelligence, Privacy, About alongside Account).
  $('#account-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openAccount(); });

  $('#new-check')?.addEventListener('click', reset);
  $('#dock-toggle')?.addEventListener('click', closeDrawer);
  $('#playbook-link')?.addEventListener('click', (e) => { e.preventDefault(); setBottom(true); });

  // learn where the read runs (local vs hosted) so the privacy line is honest
  initRead();

  // expandable panels — left sidebar · bottom drawer · right dock
  loadLibrary();   // populate History/Library from the store (local now; cloud after initCloud)
  $('#panel-left')?.addEventListener('click', () => setSidebar(shell.dataset.side !== 'open'));
  $('#panel-bottom')?.addEventListener('click', () => setBottom(shell.dataset.bottom !== 'open'));
  $('#panel-right')?.addEventListener('click', () => { if (shell.dataset.dock === 'open') closeDrawer(); else openDrawer(); });
  $('#side-close')?.addEventListener('click', () => setSidebar(false));
  $('#bottom-close')?.addEventListener('click', () => setBottom(false));

  // History sidebar (delegated): click a saved check to re-open it; or clear all.
  $('#side-body')?.addEventListener('click', (e) => {
    if (e.target.closest('#side-clear')) { clearAll(); return; }
    const row = e.target.closest('.recent[data-id]');
    if (row) reopenAsset(row.dataset.id);
  });
  $('#side-body')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.recent[data-id]');
    if (row) { e.preventDefault(); reopenAsset(row.dataset.id); }
  });

  // Library tool (delegated): card buttons (re-check / download / remove), card body
  // re-opens, search filters, "Clear all" wipes the library.
  $('#lib-grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.lib-act[data-act]');
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.act === 'recheck') reopenAsset(id);
      else if (btn.dataset.act === 'download') downloadAsset(id);
      else if (btn.dataset.act === 'remove') removeAsset(id);
      return;
    }
    const card = e.target.closest('.lib-card[data-id]');
    if (card) reopenAsset(card.dataset.id);
  });
  $('#lib-search')?.addEventListener('input', () => renderLibrary());
  $('#lib-clear')?.addEventListener('click', () => clearAll());

  // restore remembered layout
  if (store.get('panel.side', false)) setSidebar(true);
  if (store.get('panel.bottom', false)) setBottom(true);
  if (store.get('panel.dock', false)) openDrawer();

  // optional cloud: resolve any persisted session, then keep the UI in step with it
  initCloud();
}

// Resolve the saved session (if cloud is configured) and react to sign-in/out.
async function initCloud() {
  if (!cloudConfigured()) return;
  onAuth(() => { syncAvatar(); loadLibrary(); });   // session refresh / token expiry
  try { await initAuth(); } catch {}
  syncAvatar();
  await loadLibrary();   // signed in → pull cloud library; signed out → local
}

initShell();
urlInput.focus();
