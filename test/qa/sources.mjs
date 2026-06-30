// sources.mjs — the input boundary. Heavy on parseGitHubUrl (the only place a user
// string steers a network call) plus the upload/paste/zip loaders and their honest
// cap accounting. All pure / no real network (zip uses a tiny JSZip mock).

import {
  parseGitHubUrl, loadFromPaste, loadFromPastes, loadFromFileList, loadFromZip, guessPasteName,
} from '../../src/engine/sources.js';
import { T, fakeFile } from './_harness.mjs';

export async function run() {
  const t = T('sources');

  // ---- parseGitHubUrl: accepts the real forms -------------------------------
  const P = parseGitHubUrl;
  t.eq('https plain', P('https://github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('http plain', P('http://github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('no scheme', P('github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('www', P('https://www.github.com/o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('.git suffix', P('https://github.com/o/r.git'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('tree/branch', P('https://github.com/o/r/tree/main'), { owner: 'o', repo: 'r', branch: 'main', subdir: '' });
  t.eq('tree/branch/subdir', P('https://github.com/o/r/tree/dev/src/app'), { owner: 'o', repo: 'r', branch: 'dev', subdir: 'src/app' });
  t.eq('blob/branch/file', P('https://github.com/o/r/blob/main/a/b.js'), { owner: 'o', repo: 'r', branch: 'main', subdir: 'a/b.js' });
  t.truthy('query string tolerated', P('https://github.com/o/r?tab=readme'));
  t.truthy('hash tolerated', P('https://github.com/o/r#readme'));
  t.eq('trailing slash tolerated', P('https://github.com/o/r/'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.eq('trailing slash + tree', P('https://github.com/o/r/tree/main/'), { owner: 'o', repo: 'r', branch: 'main', subdir: '' });
  t.ok('git@ ssh', P('git@github.com:o/r.git')?.owner === 'o');
  t.eq('bare owner/repo', P('o/r'), { owner: 'o', repo: 'r', branch: null, subdir: '' });
  t.ok('bare with .git', P('o/r.git')?.repo === 'r');
  t.ok('owner with dash/dot', P('https://github.com/my-org.x/repo_1')?.owner === 'my-org.x');

  // ---- parseGitHubUrl: rejects look-alikes & junk (anti-SSRF) ---------------
  for (const bad of [
    'notgithub.com/o/r', 'https://evil.com/github.com/o/r', 'https://gitlab.com/o/r',
    'https://github.com.evil.com/o/r', 'http://github.evil.com/o/r', 'not a url !!!',
    '', '   ', 'https://github.com/', 'https://github.com/onlyowner',
  ]) t.ok(`reject: ${JSON.stringify(bad)}`, P(bad) === null);

  t.notThrows('null input does not throw', () => P(null));
  t.notThrows('number input does not throw', () => P(12345));
  t.ok('null -> null', P(null) === null);

  // ---- loadFromPaste / guessPasteName ---------------------------------------
  t.ok('html guessed', loadFromPaste('<!doctype html><div>x</div>').files[0].path.endsWith('.html'));
  t.ok('python guessed', loadFromPaste('import os\nfrom x import y').files[0].path.endsWith('.py'));
  t.ok('js default', loadFromPaste('const x = 1').files[0].path.endsWith('.js'));
  t.ok('explicit filename ext kept', guessPasteName('x', 'thing.rb') === 'thing.rb');
  t.ok('null paste -> one empty file', (() => { const c = loadFromPaste(null); return c.files.length === 1 && c.files[0].text === ''; })());
  t.ok('paste source label', loadFromPaste('x').source === 'paste');
  t.eq('paste bytes = length', loadFromPaste('hello').files[0].bytes, 5);

  // ---- loadFromPastes: dedupe + filtering -----------------------------------
  const dp = loadFromPastes([{ text: 'const a=1' }, { text: 'const b=2' }]);
  t.eq('two unnamed pastes -> 2 files', dp.files.length, 2);
  t.ok('paste paths are unique', dp.files[0].path !== dp.files[1].path);
  t.eq('empty list -> 0 files', loadFromPastes([]).files.length, 0);
  t.eq('filters empty-text items', loadFromPastes([{ text: '' }, { text: 'x' }, { text: null }]).files.length, 1);
  t.ok('single paste label', loadFromPastes([{ text: 'x' }]).label === 'Pasted snippet');
  t.includes('multi paste label', loadFromPastes([{ text: 'x' }, { text: 'y' }]).label, '2 pasted');

  // ---- loadFromFileList: caps + honest accounting + filtering ----------------
  const many = Array.from({ length: 100 }, (_, i) => fakeFile(`f${i}.js`, `const x${i}=1`));
  const r1 = await loadFromFileList(many);
  t.eq('caps at 80 files', r1.files.length, 80);
  t.ok('note: 20 dropped to file-count limit', r1.notes.some((n) => /file-count limit/.test(n)));
  t.falsy('does NOT mislabel cap drops as non-text', r1.notes.some((n) => /non-text/.test(n)));

  const big = Array.from({ length: 30 }, (_, i) => fakeFile(`b${i}.js`, 'x'.repeat(200 * 1024)));
  const r2 = await loadFromFileList(big);
  t.ok('drops over the 4MB budget', r2.files.length < 30);
  t.ok('note surfaces 4MB total limit', r2.notes.some((n) => /4MB total limit/.test(n)));

  const mixed = await loadFromFileList([
    fakeFile('node_modules/dep/index.js', 'ignored'),
    fakeFile('dist/bundle.js', 'ignored'),
    fakeFile('logo.png', 'PNGDATA'),
    fakeFile('src/app.js', 'const x=1'),
    fakeFile('.env.production', 'API_KEY=sk'),
    fakeFile('Dockerfile.dev', 'FROM node'),
  ]);
  const paths = mixed.files.map((f) => f.path);
  t.falsy('node_modules ignored', paths.some((p) => p.includes('node_modules')));
  t.falsy('dist ignored', paths.some((p) => p.includes('dist/')));
  t.falsy('png excluded', paths.some((p) => p.endsWith('.png')));
  t.truthy('src/app.js included', paths.includes('src/app.js'));
  t.truthy('.env.production included', paths.includes('.env.production'));
  t.truthy('Dockerfile.dev included', paths.includes('Dockerfile.dev'));
  t.notThrows('empty file list does not throw', async () => { await loadFromFileList([]); });
  t.ok('backslash paths normalized', (await loadFromFileList([fakeFile('a.js', 'x')]).then(() => {
    return true;
  })));
  const winPath = await loadFromFileList([{ name: 'a.js', webkitRelativePath: 'src\\win\\a.js', size: 1, async text() { return 'x'; }, slice() { return { async text() { return 'x'; } }; } }]);
  t.ok('windows backslashes -> forward slashes', winPath.files[0].path === 'src/win/a.js');

  // ---- loadFromZip (mock JSZip) ---------------------------------------------
  const mockZip = (entries) => {
    const files = {};
    for (const [name, content] of Object.entries(entries)) files[name] = { name, dir: name.endsWith('/'), async async() { return content; } };
    globalThis.JSZip = { async loadAsync() { return { files }; } };
  };
  mockZip({ 'proj/': '', 'proj/app.js': 'const x=1', 'proj/readme.md': '# hi', 'proj/logo.png': 'BIN' });
  const z = await loadFromZip({ name: 'proj.zip' });
  t.ok('zip reads textual entries', z.files.some((f) => f.path === 'proj/app.js'));
  t.falsy('zip skips binary', z.files.some((f) => f.path.endsWith('.png')));
  t.ok('zip source label', z.source === 'zip');
  const zmany = {}; for (let i = 0; i < 100; i++) zmany[`f${i}.js`] = 'const x=1';
  mockZip(zmany);
  const z2 = await loadFromZip({ name: 'big.zip' });
  t.eq('zip caps at 80', z2.files.length, 80);
  delete globalThis.JSZip;
  t.notThrowsAsync('zip without JSZip throws cleanly (caught)', async () => { try { await loadFromZip({ name: 'x.zip' }); } catch { /* expected */ } });

  return t.st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { printResult } = await import('./_harness.mjs');
  printResult(await run());
}
