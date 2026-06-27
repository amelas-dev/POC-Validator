// sources.test.mjs — the untrusted-input boundary: GitHub URL parsing, the paste loader, the
// file-list cap/accounting, and the advisor code digest. Pure/near-pure (no network), so these
// lock in the loader fixes (anchored host parsing, .env.* admission, honest truncation notes,
// digest hardening) without a browser.
//
//   node test/sources.test.mjs

import { parseGitHubUrl, loadFromPaste, loadFromFileList } from '../src/engine/sources.js';
import { buildCodeDigest } from '../src/llm/context.js';

const R = '\x1b[31m', G = '\x1b[32m', X = '\x1b[0m', B = '\x1b[1m';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ${R}✗${X} ${name}`); } };
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

console.log(`${B}parseGitHubUrl — anchored host, tree/blob, ssh, bare${X}`);
eq('https plain', parseGitHubUrl('https://github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
eq('tree/branch/subdir', parseGitHubUrl('https://github.com/o/r/tree/dev/src/app'), { owner: 'o', repo: 'r', branch: 'dev', subdir: 'src/app' });
ok('blob/branch -> branch captured', parseGitHubUrl('https://github.com/o/r/blob/dev/file.js')?.branch === 'dev');
ok('git@ ssh form', parseGitHubUrl('git@github.com:o/r.git')?.owner === 'o');
ok('bare owner/repo', parseGitHubUrl('o/r')?.repo === 'r');
ok('.git suffix stripped', parseGitHubUrl('https://github.com/o/r.git')?.repo === 'r');
ok('look-alike host -> null', parseGitHubUrl('notgithub.com/o/r') === null);
ok('embedded look-alike -> null', parseGitHubUrl('https://evil.com/github.com/o/r') === null);
ok('garbage -> null', parseGitHubUrl('not a url at all !!!') === null);

console.log(`${B}loadFromPaste — language guess + null-safety${X}`);
ok('html guessed', loadFromPaste('<!doctype html><div>x</div>').files[0].path.endsWith('.html'));
ok('python guessed', loadFromPaste('import os\nfrom x import y').files[0].path.endsWith('.py'));
ok('js default', loadFromPaste('const x = 1').files[0].path.endsWith('.js'));
ok('null does not throw, yields one empty file', (() => { const c = loadFromPaste(null); return c.files.length === 1 && c.files[0].text === ''; })());

console.log(`${B}loadFromFileList — caps + honest accounting (FIX-09 / FIX-22)${X}`);
const fakeFile = (path, content) => ({
  name: path.split('/').pop(), webkitRelativePath: path, size: content.length,
  async text() { return content; }, slice(a, b) { return { async text() { return content.slice(a, b); } }; },
});

// 100 small textual files -> MAX_FILES=80 analyzed, 20 attributed to the file-count cap (NOT "non-text").
const many = Array.from({ length: 100 }, (_, i) => fakeFile(`f${i}.js`, `const x${i}=1;`));
const r1 = await loadFromFileList(many);
ok('caps analyzed files at 80', r1.files.length === 80);
ok('note attributes 20 drops to the file-count limit', r1.notes.some((n) => /file-count limit/.test(n)));
ok('does NOT mislabel cap-dropped files as non-text', !r1.notes.some((n) => /20 non-text/.test(n)));

// ~6MB of textual files -> some dropped by the 4MB total budget, surfaced honestly.
const big = Array.from({ length: 30 }, (_, i) => fakeFile(`b${i}.js`, 'x'.repeat(200 * 1024)));
const r2 = await loadFromFileList(big);
ok('drops over-budget files (kept < 30)', r2.files.length < 30);
ok('note surfaces the 4MB total-limit drop', r2.notes.some((n) => /4MB total limit/.test(n)));

// FIX-22: .env.production / Dockerfile.dev are admitted as textual config.
const envList = await loadFromFileList([fakeFile('.env.production', 'API_KEY=sk-x'), fakeFile('Dockerfile.dev', 'FROM node')]);
ok('.env.production is analyzed (not dropped)', envList.files.some((f) => f.path === '.env.production'));
ok('Dockerfile.dev is analyzed', envList.files.some((f) => f.path === 'Dockerfile.dev'));

console.log(`${B}buildCodeDigest — hardened (FIX-16 / FIX-24)${X}`);
ok('file missing path does not throw', (() => { try { buildCodeDigest({ files: [{ text: 'x=1' }] }); return true; } catch { return false; } })());
ok('non-array files does not throw -> empty digest', (() => { try { return buildCodeDigest({ files: {} }).code === '(no readable source files)'; } catch { return false; } })());
ok('single one-line "minified" real file still included (FIX-24 fallback)', (() => {
  const d = buildCodeDigest({ files: [{ path: 'a.js', text: 'a'.repeat(3000) }] });
  return d.manifest.included.length >= 1 && d.code !== '(no readable source files)';
})());

console.log('');
if (fail === 0) console.log(`${G}sources + digest suite: ${pass}/${pass} passed${X}`);
else console.log(`${R}sources + digest suite: ${fail} FAILED, ${pass} passed${X}`);
process.exit(fail ? 1 : 0);
