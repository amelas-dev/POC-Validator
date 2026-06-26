// scan.js — run the ruleset patterns over a normalized corpus and return,
// for each signal, the concrete evidence (file path + line + matched text).
//
// The scan is deliberately dumb and transparent: regex matches, nothing more.
// All judgment about what the matches MEAN lives in classify.js. Keeping the
// two apart is what lets the UI show "here is exactly what we saw, and here is
// why it matters" as two separate, auditable layers.

import { SIGNALS } from './ruleset.js';

const MAX_EVIDENCE_PER_SIGNAL = 6;
const MAX_MATCHES_PER_PATTERN_PER_FILE = 4;

// Compile every pattern once. Case-insensitive + multiline; global so we can
// walk all matches and recover line numbers from match offsets.
const COMPILED = SIGNALS.map((signal) => ({
  signal,
  regexes: signal.patterns.map((p) => {
    try {
      return new RegExp(p, 'gim');
    } catch {
      // A malformed pattern should never break the whole scan.
      return null;
    }
  }),
}));

// Signals whose matches only "count" when they appear in code that actually
// ships at runtime (or in a manifest's runtime dependencies) — not in docs,
// tests, or build-only config. The AI build-tool that authored a utility, or
// an SDK named only in a README, must never set the lane.
const RUNTIME_SCOPED = new Set([
  'runtime-ai-direct-vendor-host',
  'runtime-ai-vendor-sdk-import',
  'client-side-model-api-key',
  'backend-server-present',
  'third-party-cdn-script',
  'third-party-analytics-telemetry',
]);

function fileRole(path) {
  const p = path.toLowerCase();
  const base = p.split('/').pop();
  if (/(^|\/)(readme|changelog|contributing|license|notice)/.test(p) || /\.(md|markdown|rst|adoc)$/.test(p)) return 'doc';
  if (/(^|\/)(tests?|spec|__tests__|__mocks__|e2e|cypress)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p)) return 'test';
  if (/(^|\/)(package\.json|package-lock\.json|requirements\.txt|pipfile|pyproject\.toml|gemfile|go\.mod|cargo\.toml)$/.test(base) || base === 'package.json') return 'manifest';
  if (/\.(txt|csv)$/.test(p)) return 'note';
  return 'runtime';
}

function extOf(path) {
  const base = path.split('/').pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

// Which comment styles apply to a file, so we can blank comments before matching.
function commentStyle(path) {
  const e = extOf(path);
  if (['css', 'sass'].includes(e)) return { line: [], block: [['/*', '*/']] };
  if (['scss', 'less'].includes(e)) return { line: ['//'], block: [['/*', '*/']] };
  if (['html', 'htm', 'vue', 'svelte', 'xml', 'md', 'markdown'].includes(e)) return { line: [], block: [['<!--', '-->']] };
  if (['py', 'rb', 'sh', 'bash', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'r', 'tf', 'tfvars', 'properties'].includes(e)) return { line: ['#'], block: [] };
  if (['sql', 'graphql', 'gql'].includes(e)) return { line: ['--'], block: [['/*', '*/']] };
  return { line: ['//'], block: [['/*', '*/']] }; // js/ts/jsx/tsx/java/go/rs/c/cs/php/…
}

// Return a copy of `text` with comments replaced by spaces (newlines preserved,
// so offsets and line numbers stay identical). String literals are respected so
// `//` inside "https://…" is never mistaken for a comment.
export function stripComments(path, text) {
  const { line, block } = commentStyle(path);
  const out = text.split('');
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, str = null;
  while (i < n) {
    const ch = text[i];
    if (str) { if (ch === '\\') { i += 2; continue; } if (ch === str) str = null; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; i++; continue; }
    let hit = false;
    for (const [op, cl] of block) {
      if (text.startsWith(op, i)) { const e = text.indexOf(cl, i + op.length); const stop = e < 0 ? n : e + cl.length; blank(i, stop); i = stop; hit = true; break; }
    }
    if (hit) continue;
    for (const tok of line) {
      if (text.startsWith(tok, i)) {
        if (tok === '//' && text[i - 1] === ':') break; // protect URLs like https://
        const nl = text.indexOf('\n', i); const stop = nl < 0 ? n : nl; blank(i, stop); i = stop; hit = true; break;
      }
    }
    if (hit) continue;
    i++;
  }
  return out.join('');
}

// Map a match index -> 1-based line number in O(log n). The line-start table is built
// lazily on first use, so files that produce zero matches never pay for it.
function lineIndexer(text) {
  let starts = null;
  return (idx) => {
    if (!starts) {
      starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    }
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

function snippetAround(text, idx, matchLen) {
  // Return the trimmed line containing the match, clipped for display.
  let start = text.lastIndexOf('\n', idx) + 1;
  let end = text.indexOf('\n', idx + matchLen);
  if (end === -1) end = text.length;
  let line = text.slice(start, end).trim();
  if (line.length > 160) {
    const rel = idx - start;
    const from = Math.max(0, rel - 60);
    line = (from > 0 ? '…' : '') + line.slice(from, from + 150).trim() + '…';
  }
  return line;
}

// Compute the {start,end} character span of a package.json's "devDependencies" object
// ONCE per file. Returns null when there is no such span (not a manifest, no devDeps, or
// malformed) — i.e. when every match should count as a runtime dependency.
function devDepsRange(path, text) {
  if (!/package\.json$/i.test(path)) return null;
  const dev = text.search(/"devDependencies"\s*:/);
  if (dev === -1) return null;
  let depth = 0, start = text.indexOf('{', dev), end = -1;
  if (start === -1) return null;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end === -1 ? null : { start, end };
}

/**
 * Scan a corpus ({ files: [{path, text}] }) and return a map of signalId ->
 * { signal, evidence: [{path, line, text, role, runtime}], runtimeEvidence, fired, firedRuntime }.
 */
export function scanCorpus(corpus) {
  const files = (corpus && corpus.files) || [];
  // Precompute per-file once: role, original text (for display), comment-stripped
  // text (for matching), and a line indexer.
  const prepared = files.map((file) => {
    const text = file.text || '';
    return { path: file.path, role: fileRole(file.path), text, stripped: stripComments(file.path, text), toLine: lineIndexer(text), devRange: devDepsRange(file.path, text) };
  });
  const results = {};

  for (const { signal, regexes } of COMPILED) {
    const evidence = [];
    for (const f of prepared) {
      if (evidence.length >= MAX_EVIDENCE_PER_SIGNAL) break;
      const { path, role, text, stripped, toLine, devRange } = f;

      for (let ri = 0; ri < regexes.length; ri++) {
        const re = regexes[ri];
        if (!re) continue;
        re.lastIndex = 0;
        let m;
        let perPattern = 0;
        // Test the path itself (for path-oriented patterns like (^|/)Dockerfile$).
        if (re.test(path)) {
          evidence.push({ path, line: 0, text: path, role, runtime: role !== 'doc' && role !== 'test', via: 'path', patternIndex: ri });
        }
        re.lastIndex = 0;
        // Match against comment-stripped text so matches inside comments don't count.
        while ((m = re.exec(stripped)) !== null && perPattern < MAX_MATCHES_PER_PATTERN_PER_FILE) {
          const idx = m.index;
          const runtimeOk = role === 'manifest' ? !(devRange && idx > devRange.start && idx < devRange.end) : (role !== 'doc' && role !== 'test');
          evidence.push({
            path,
            line: toLine(idx),
            text: snippetAround(text, idx, m[0].length),
            role,
            runtime: runtimeOk,
            via: 'content',
            patternIndex: ri,
          });
          perPattern++;
          if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
          if (evidence.length >= MAX_EVIDENCE_PER_SIGNAL) break;
        }
        if (evidence.length >= MAX_EVIDENCE_PER_SIGNAL) break;
      }
    }

    const runtimeEvidence = evidence.filter((e) => e.runtime);
    const requiresRuntime = RUNTIME_SCOPED.has(signal.id);
    results[signal.id] = {
      signal,
      evidence,
      runtimeEvidence,
      fired: evidence.length > 0,
      // For runtime-scoped signals, only count as "fired for the verdict" when
      // there is real runtime/manifest evidence — not doc/test mentions alone.
      firedRuntime: requiresRuntime ? runtimeEvidence.length > 0 : evidence.length > 0,
    };
  }

  // Expose the prepared per-file data (role + comment-stripped text) so classify.js can
  // reuse it instead of recomputing fileRole and re-running stripComments on every file.
  return { signals: results, fileCount: files.length, files: prepared };
}

export { fileRole };
