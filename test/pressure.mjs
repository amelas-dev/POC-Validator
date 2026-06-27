// Pressure-test runner: replay agent-generated adversarial cases through the
// REAL engine and triangulate three independent opinions on the correct lane —
// the generator's expected, a second agent's blind verification, and the engine.
//
//   node test/pressure.mjs <cases.json>
//
// Disagreement patterns:
//   generator == verifier, engine differs  ->  likely ENGINE MISS (a real weakness)
//   generator != verifier                  ->  AMBIGUOUS / un-inferable (engine defensible)
//   all three agree                         ->  engine correct on a hard case

import { readFileSync } from 'node:fs';
import { analyze } from '../src/engine/classify.js';

const file = process.argv[2];
if (!file) { console.error('usage: node test/pressure.mjs <cases.json>'); process.exit(2); }
const data = JSON.parse(readFileSync(file));
const cases = data.cases || data;
const vById = Object.fromEntries((data.verifications || []).map((v) => [v.id, v]));

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const binary = (s) => (s && s.startsWith('Lane 1') ? 'Lane 1' : 'Lane 2');

let ok = 0, miss = 0, ambig = 0;
const misses = [], ambigs = [];

// Setup integrity (exit 2): every case must carry non-empty text AND a matching verifier.
// Without text a case silently analyzes empty -> false Lane-1 pass; without a verifier a real
// engine miss can only ever read as 'ambig' (defensible), hiding a coverage gap.
const setupErrors = [];
for (const c of cases) {
  for (const f of c.files) {
    const t = f.snippet ?? f.text;
    if (typeof t !== 'string' || t.length === 0) setupErrors.push(`${c.id}: file ${f.path} has no snippet/text`);
  }
  if (!vById[c.id]) setupErrors.push(`${c.id}: no verifier (cannot be triaged as a miss)`);
}
if (setupErrors.length) { console.error(`${R}Pressure setup error:${X}\n  ${setupErrors.join('\n  ')}`); process.exit(2); }

for (const c of cases) {
  const r = analyze({ source: 'upload', label: c.id, files: c.files.map((f) => ({ path: f.path, text: f.snippet ?? f.text })), meta: {}, notes: [] });
  const eng = r.verdict.lane;
  const gen = c.expectedLane;
  const v = vById[c.id];
  const ver = v ? v.lane : null;
  const eb = binary(eng), gb = binary(gen), vb = ver ? binary(ver) : null;
  const fails = r.conditions.filter((x) => !x.status.includes('pass')).map((x) => x.ref).join(',') || '-';

  let kind;
  if (vb && gb === vb) kind = (eb === gb) ? 'ok' : 'miss';
  else kind = 'ambig';
  if (kind === 'ok') ok++; else if (kind === 'miss') { miss++; misses.push({ c, r, eng, gen, ver, fails }); }
  else { ambig++; ambigs.push({ c, r, eng, gen, ver, fails }); }

  const mark = kind === 'ok' ? `${G}✓${X}` : kind === 'miss' ? `${R}✗ MISS${X}` : `${Y}≈ ambig${X}`;
  console.log(`${mark} ${B}${c.id}${X} ${D}${c.title}${X}`);
  console.log(`   engine: ${eb === gb || !vb ? '' : (eb === vb ? G : R)}${eng}${X}   gen: ${gen}   verify: ${ver || '?'}   ${D}[${c.attack}]${X}`);
  console.log(`   ${D}fails ${fails} · conf ${r.confidence.level} · data ${r.assumptions.dataScope} · tier ${r.tier}${X}`);
}

console.log('');
console.log(`${B}Engine vs. two independent judges (${cases.length} cases):${X}`);
console.log(`  ${G}✓ correct on hard case:${X} ${ok}`);
console.log(`  ${R}✗ likely engine miss:${X}   ${miss}   ${D}(generator + verifier agree, engine differs)${X}`);
console.log(`  ${Y}≈ ambiguous/un-inferable:${X} ${ambig}   ${D}(the two judges disagree — engine's call is defensible)${X}`);

if (misses.length) {
  console.log(`\n${B}${R}=== Engine misses (real weaknesses to fix) ===${X}`);
  for (const m of misses) {
    console.log(`\n${B}${m.c.id}${X} — ${m.c.title}`);
    console.log(`  attack:   ${m.c.attack}`);
    console.log(`  engine:   ${R}${m.eng}${X} (fails ${m.fails})`);
    console.log(`  correct:  ${G}${m.gen}${X}  ${D}(generator & verifier agree)${X}`);
    console.log(`  why:      ${m.c.rationale}`);
  }
}
if (ambigs.length) {
  console.log(`\n${B}${Y}=== Ambiguous (judges split — for the record) ===${X}`);
  for (const a of ambigs) console.log(`  ${a.c.id}: engine ${a.eng} · gen ${a.gen} · verify ${a.ver}  ${D}— ${a.c.attack}${X}`);
}
// A confirmed engine miss (generator + verifier agree, engine differs) fails the suite so a
// regression can't slip through CI. Ambiguous cases (judges split) do not fail.
process.exit(miss ? 1 : 0);
