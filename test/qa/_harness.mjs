// _harness.mjs — a tiny zero-dep assertion harness shared by the go-live QA suite.
// Each qa module exports `run()` returning {name, pass, fail, fails}; run-all.mjs
// aggregates them into one headline count. Mirrors the style of the existing
// test/*.mjs (no framework), just factored so 300+ cases stay readable.

import { performance } from 'node:perf_hooks';

export function T(name) {
  const st = { name, pass: 0, fail: 0, fails: [] };
  const api = {
    st,
    ok(label, cond) { if (cond) st.pass++; else { st.fail++; st.fails.push(label); } return !!cond; },
    eq(label, a, b) { const A = JSON.stringify(a), B = JSON.stringify(b); return api.ok(`${label} | got ${A} want ${B}`, A === B); },
    truthy(label, v) { return api.ok(label, !!v); },
    falsy(label, v) { return api.ok(label + ' (falsy)', !v); },
    includes(label, hay, needle) { return api.ok(`${label} | ${JSON.stringify(hay)} ∋ ${JSON.stringify(needle)}`, String(hay).includes(needle)); },
    throws(label, fn) { let threw = false; try { fn(); } catch { threw = true; } return api.ok(label + ' (throws)', threw); },
    notThrows(label, fn) { let ok = true, err; try { fn(); } catch (e) { ok = false; err = e; } return api.ok(label + (ok ? '' : ` (threw ${err && err.message || err})`), ok); },
    async notThrowsAsync(label, fn) { let ok = true, err; try { await fn(); } catch (e) { ok = false; err = e; } return api.ok(label + (ok ? '' : ` (threw ${err && err.message || err})`), ok); },
    // Perf budget: run fn and assert it finished within budgetMs. Returns elapsed ms.
    async within(label, budgetMs, fn) { const t0 = performance.now(); await fn(); const ms = performance.now() - t0; api.ok(`${label} (${ms.toFixed(1)}ms <= ${budgetMs}ms)`, ms <= budgetMs); return ms; },
  };
  return api;
}

// ---- corpus builders (the engine's input shape) ---------------------------
export const corpusOf = (files, extra = {}) => ({
  source: 'upload', label: 't',
  files: files.map((f) => ({ path: f.path, text: f.text, bytes: f.text.length })),
  meta: {}, notes: [], ...extra,
});
export const fileCorpus = (path, text, extra = {}) => corpusOf([{ path, text }], extra);

// A File-like object good enough for loadFromFileList / loadFromSpreadsheet tests.
export const fakeFile = (path, content) => ({
  name: path.split('/').pop(),
  webkitRelativePath: path,
  size: typeof content === 'string' ? content.length : content.byteLength,
  async text() { return typeof content === 'string' ? content : Buffer.from(content).toString('utf8'); },
  async arrayBuffer() { return typeof content === 'string' ? new TextEncoder().encode(content).buffer : content; },
  slice(a, b) { const c = content; return { async text() { return (typeof c === 'string' ? c : Buffer.from(c).toString('utf8')).slice(a, b); } }; },
});

export const LANE_RANK = { lane1: 0, lane2: 1, approve: 2 };

export function printResult(st) {
  const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
  if (st.fail === 0) console.log(`${G}✓ ${st.name}: ${st.pass}/${st.pass} passed${X}`);
  else {
    console.log(`${R}✗ ${st.name}: ${st.fail} FAILED, ${st.pass} passed${X}`);
    for (const f of st.fails) console.log(`    ${R}·${X} ${f}`);
  }
  return st;
}
