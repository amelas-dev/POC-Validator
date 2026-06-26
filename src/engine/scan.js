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

// Precompute line-start offsets so a match index -> 1-based line number is O(log n).
function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
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

// Is a package-name match inside a manifest actually a runtime dependency?
// (Used to avoid flagging an SDK that only appears under devDependencies.)
function isRuntimeManifestMatch(path, text, idx) {
  if (!/package\.json$/i.test(path)) return true; // only special-case package.json
  const dev = text.search(/"devDependencies"\s*:/);
  if (dev === -1) return true;
  // Find the extent of the devDependencies object and see if idx falls inside it.
  let depth = 0, start = text.indexOf('{', dev), end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start !== -1 && end !== -1 && idx > start && idx < end) return false; // dev-only
  return true;
}

/**
 * Scan a corpus ({ files: [{path, text}] }) and return a map of signalId ->
 * { signal, evidence: [{path, line, text, role, runtime}], runtimeEvidence, fired, firedRuntime }.
 */
export function scanCorpus(corpus) {
  const files = (corpus && corpus.files) || [];
  const results = {};

  for (const { signal, regexes } of COMPILED) {
    const evidence = [];
    for (const file of files) {
      if (evidence.length >= MAX_EVIDENCE_PER_SIGNAL) break;
      const path = file.path;
      const role = fileRole(path);
      const text = file.text || '';
      const toLine = lineIndexer(text);

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
        while ((m = re.exec(text)) !== null && perPattern < MAX_MATCHES_PER_PATTERN_PER_FILE) {
          const idx = m.index;
          const runtimeOk = role === 'manifest' ? isRuntimeManifestMatch(path, text, idx) : (role !== 'doc' && role !== 'test');
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

  return { signals: results, fileCount: files.length };
}

export { fileRole };
