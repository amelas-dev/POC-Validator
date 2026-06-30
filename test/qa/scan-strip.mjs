// scan-strip.mjs — the comment-stripper is load-bearing: every detector runs on
// stripped text, so a stripping bug either hides a real signal (comment eats code)
// or surfaces a fake one (string read as code). These lock the invariants:
// offsets/line-count preserved, strings respected, URLs intact, per-language styles.

import { stripComments, scanCorpus, fileRole } from '../../src/engine/scan.js';
import { analyze } from '../../src/engine/classify.js';
import { T, fileCorpus } from './_harness.mjs';

export async function run() {
  const t = T('scan-strip');
  const a = (p, c) => analyze(fileCorpus(p, c));

  // ---- structural invariants: length + line count preserved -----------------
  const samples = [
    ['a.js', "const x = 1; // trailing\n/* block\nspanning */\nconst y = 2;"],
    ['a.py', "x = 1  # comment\ny = 2"],
    ['a.sql', "SELECT 1 -- note\nFROM t"],
    ['a.html', "<div><!-- hi --></div>\n<script>// c\nvar x=1;</script>"],
    ['a.vba', "Dim x ' comment\nRem another\nMsgBox x"],
  ];
  for (const [p, txt] of samples) {
    const s = stripComments(p, txt);
    t.eq(`${p}: length preserved`, s.length, txt.length);
    t.eq(`${p}: newline count preserved`, (s.match(/\n/g) || []).length, (txt.match(/\n/g) || []).length);
  }

  // ---- comments are blanked; code survives ----------------------------------
  t.falsy('js // comment removed', stripComments('a.js', '// secret\ncode').includes('secret'));
  t.truthy('js code survives', stripComments('a.js', '// x\nKEEPME').includes('KEEPME'));
  t.falsy('js /* */ removed', stripComments('a.js', '/* gone */KEEPME').includes('gone'));
  t.falsy('py # removed', stripComments('a.py', '# gone\nKEEPME').includes('gone'));
  t.truthy('py code survives', stripComments('a.py', '# x\nKEEPME').includes('KEEPME'));
  t.falsy('sql -- removed', stripComments('q.sql', 'SELECT 1 -- gone').includes('gone'));
  t.falsy('html <!-- --> removed', stripComments('a.html', '<!-- gone -->KEEP').includes('gone'));
  t.falsy("vba ' removed", stripComments('m.vba', "Dim x ' gone").includes('gone'));
  t.falsy('vba Rem removed', stripComments('m.vba', 'Rem gone\nKEEP').includes('gone'));

  // ---- strings are respected (NOT mistaken for comments) ---------------------
  t.truthy('url with // inside string preserved', stripComments('a.js', 'const u = "https://api.openai.com/v1"').includes('api.openai.com'));
  t.truthy('// inside string literal kept', stripComments('a.js', 'const s = "a // b"').includes('a // b'));
  // A /* inside one string must NOT start a block comment that eats later code.
  t.truthy('block-open inside string does not eat code',
    stripComments('a.js', 'const a = "/*"; const MIDDLE = 1; const b = "*/";').includes('MIDDLE'));
  t.truthy('# inside python string kept', stripComments('a.py', 's = "a # b"').includes('a # b'));
  // dquote-only languages: ' is a comment, not a string opener (VBA).
  t.falsy("vba apostrophe in code is comment", stripComments('m.vba', "x = 1 ' note GONE").includes('GONE'));

  // ---- consequence: a signal that exists ONLY in a comment must not fire -----
  t.ok('AI call only in a // comment -> c55 passes', a('x.js', "// fetch('https://api.openai.com/v1',{method:'POST'})\nconst y=1").conditions.find((c) => c.id === 'c55').status === 'pass');
  t.ok('INSERT only in a # comment -> c53 passes', a('x.py', "# INSERT INTO ledger VALUES (1)\ny = 1").conditions.find((c) => c.id === 'c53').status === 'pass');
  // ...but the SAME token in a real string is live code (a SQL string IS a write).
  t.ok('INSERT in a real string -> c53 not pass', a('x.js', "db.query('INSERT INTO ledger VALUES (1)')").conditions.find((c) => c.id === 'c53').status !== 'pass');
  // commented-out vendor host inside inline <script> must not ship
  t.ok('commented host in inline <script> -> c55 passes', a('p.html', "<script>// fetch('https://api.openai.com/v1')\nvar x=1</script>").conditions.find((c) => c.id === 'c55').status === 'pass');

  // ---- fileRole classification ----------------------------------------------
  const roles = [
    ['README.md', 'doc'], ['docs/guide.md', 'doc'], ['CHANGELOG', 'doc'],
    ['src/foo.test.js', 'test'], ['spec/bar.js', 'test'], ['__tests__/x.js', 'test'], ['a.spec.ts', 'test'],
    ['package.json', 'manifest'], ['requirements.txt', 'manifest'], ['go.mod', 'manifest'],
    ['data.csv', 'note'], ['notes.txt', 'note'], ['x.tsv', 'note'],
    ['vba/Module1.bas', 'runtime'], ['report.formulas', 'runtime'], ['x.pq', 'runtime'],
    ['src/app.js', 'runtime'], ['index.html', 'runtime'], ['main.py', 'runtime'],
  ];
  for (const [p, want] of roles) t.eq(`fileRole ${p}`, fileRole(p), want);

  // ---- scanCorpus tolerates an empty / odd corpus ---------------------------
  t.notThrows('scanCorpus({}) does not throw', () => scanCorpus({}));
  t.notThrows('scanCorpus({files:[]}) does not throw', () => scanCorpus({ files: [] }));
  t.notThrows('scanCorpus file with empty text', () => scanCorpus({ files: [{ path: 'a.js', text: '' }] }));

  return t.st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { printResult } = await import('./_harness.mjs');
  printResult(await run());
}
