// run-all.mjs — the go-live QA suite. Runs every qa/* module and prints one headline
// count across all dimensions (logic, security, speed/ReDoS, robustness, optimization)
// plus the named pressure scenarios (folders, repos, massive vs small, workbooks vs csv).
//
//   node test/qa/run-all.mjs

import { printResult } from './_harness.mjs';

const MODULES = [
  './engine-invariants.mjs',
  './detect-truth.mjs',
  './scan-strip.mjs',
  './sources.mjs',
  './spreadsheet.mjs',
  './security.mjs',
  './pressure.mjs',
];

const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m', DIM = '\x1b[2m';

let pass = 0, fail = 0;
const rows = [];
for (const mod of MODULES) {
  const { run } = await import(mod);
  const st = await run();
  printResult(st);
  pass += st.pass; fail += st.fail;
  rows.push(st);
}

console.log('');
console.log(`${B}── Go-live QA suite ──${X}`);
for (const st of rows) console.log(`  ${st.fail ? R + '✗' : G + '✓'}${X} ${st.name.padEnd(20)} ${DIM}${st.pass} checks${X}`);
console.log('');
if (fail === 0) console.log(`${G}${B}ALL GREEN — ${pass} checks across ${rows.length} modules.${X}`);
else console.log(`${R}${B}${fail} FAILED${X} (${pass} passed) across ${rows.length} modules.`);

process.exit(fail ? 1 : 0);
