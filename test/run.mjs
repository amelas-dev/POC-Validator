// Verification runner: replays the workflow-generated corpus through the engine
// in AUTO mode (no user overrides) and checks the headline Lane against the
// expected outcome. Tier is reported but treated as secondary, because tier
// depends on reliance/sensitivity facts that are not code-detectable.
//
//   npm test          run all cases
//   npm test -- -v    verbose: print every case
//   npm test -- ID    run a single case by id

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/engine/classify.js';

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url)));
const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const only = args.find((a) => !a.startsWith('-'));

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m';

function toCorpus(tc) {
  return {
    source: 'upload',
    label: tc.title,
    files: tc.files.map((f) => ({ path: f.path, text: f.snippet, bytes: f.snippet.length })),
    meta: {},
    notes: [],
  };
}

const binary = (s) => (s.startsWith('Lane 1') ? 'Lane 1' : 'Lane 2');

let binPass = 0, binFail = 0, exactPass = 0, tierPass = 0;
let total = 0;

for (const tc of corpus) {
  if (only && tc.id !== only) continue;
  total++;
  const result = analyze(toCorpus(tc));
  const gotLane = result.verdict.lane;
  const wantLane = tc.expectedLane;
  const binOk = binary(gotLane) === binary(wantLane); // primary: Lane 1 vs Lane 2
  const exactOk = gotLane === wantLane;               // secondary: incl. Approve-state
  const tierOk = result.tier === tc.expectedTier;     // secondary: un-inferable
  if (binOk) binPass++; else binFail++;
  if (exactOk) exactPass++;
  if (tierOk) tierPass++;

  if (verbose || only || !binOk || !exactOk) {
    const mark = binOk ? (exactOk ? `${GREEN}✓${RESET}` : `${YELLOW}≈${RESET}`) : `${RED}✗${RESET}`;
    const laneCol = binOk ? (exactOk ? GREEN : YELLOW) : RED;
    const tierMark = tierOk ? `${GREEN}${result.tier}${RESET}` : `${YELLOW}${result.tier}→want ${tc.expectedTier}${RESET}`;
    console.log(`${mark} ${BOLD}${tc.id}${RESET} ${DIM}${tc.title}${RESET}`);
    console.log(`    lane: ${laneCol}${gotLane}${RESET}${exactOk ? '' : `  want ${wantLane}`}   tier: ${tierMark}   posture: ${result.posture}   looks-like: ${result.pattern}`);
    const drivers = result.conditions.filter((c) => c.driving).map((c) => `${c.ref} ${c.title}`);
    console.log(`    ${DIM}drivers: ${drivers.join(' · ') || '(all pass)'}   expected-fail: ${(tc.expectedFailingConditions || []).join(', ') || '(none)'}${RESET}`);
  }
}

console.log('');
console.log(`${BOLD}Lane 1 vs Lane 2 (primary):${RESET} ${binPass}/${total}` +
  (binFail ? `  ${RED}(${binFail} wrong)${RESET}` : `  ${GREEN}all correct${RESET}`));
console.log(`${BOLD}Exact incl. Approve-state:${RESET}  ${exactPass}/${total} ${DIM}(corpus is inconsistent on the suffix)${RESET}`);
console.log(`${BOLD}Tier match:${RESET}                 ${tierPass}/${total} ${DIM}(tier hinges on un-inferable reliance/sensitivity)${RESET}`);

process.exit(binFail ? 1 : 0);
