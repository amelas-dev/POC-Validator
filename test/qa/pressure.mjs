// pressure.mjs — the go-live pressure scenarios the spec called out by name:
//   (1) a whole FOLDER of code dropped in   (2) different GIT REPO shapes
//   (3) MASSIVE codebases vs tiny one-liners  (4) complex WORKBOOKS vs trivial CSVs
// Exercises the real pipeline (sources -> scan -> classify) end to end, with a mocked
// fetch for GitHub and a mocked JSZip where a binary workbook would be needed.

import { loadFromFileList, loadFromGitHub, loadFromPaste } from '../../src/engine/sources.js';
import { loadFromSpreadsheet, csvToArtifacts } from '../../src/engine/spreadsheet.js';
import { analyze } from '../../src/engine/classify.js';
import { T, fakeFile, corpusOf } from './_harness.mjs';

const VERDICTS = new Set(['lane1', 'lane2', 'approve']);

// ---- a fetch mock that emulates the GitHub REST shapes loadFromGitHub uses ----
function mockGitHub({ defaultBranch = 'main', tree = [], contents = {}, repoStatus = 200, rateLimited = false }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const headers = { get: (k) => (k.toLowerCase() === 'x-ratelimit-remaining' ? (rateLimited ? '0' : '59') : null) };
    if (u.includes('/git/trees/')) return { ok: true, status: 200, headers, async json() { return { tree }; } };
    // Token-less (public) file bodies now come from the raw CDN: /{owner}/{repo}/{branch}/{path}.
    if (u.includes('raw.githubusercontent.com')) {
      const m = u.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
      const path = m ? m[1].split('/').map(decodeURIComponent).join('/') : '';
      if (path in contents) return { ok: true, status: 200, headers, async text() { return contents[path]; } };
      return { ok: false, status: 404, headers, async text() { return ''; } };
    }
    // Authenticated (private-repo) file bodies still go through the Contents API.
    if (u.includes('/contents/')) {
      const m = u.match(/\/contents\/([^?]+)\?/);
      const path = m ? m[1].split('/').map(decodeURIComponent).join('/') : '';
      if (path in contents) return { ok: true, status: 200, headers, async text() { return contents[path]; } };
      return { ok: false, status: 404, headers, async text() { return ''; } };
    }
    // the repo metadata call
    if (rateLimited) return { ok: false, status: 403, headers, async json() { return {}; } };
    if (repoStatus !== 200) return { ok: false, status: repoStatus, headers, async json() { return {}; } };
    return { ok: true, status: 200, headers, async json() { return { default_branch: defaultBranch, description: 'd', language: 'JS', html_url: 'h', stargazers_count: 1 }; } };
  };
}

export async function run() {
  const t = T('pressure');
  const realFetch = globalThis.fetch;

  // ===== (1) a FOLDER dropped in ============================================
  const langs = ['js', 'ts', 'py', 'go', 'java', 'rb', 'php', 'cs', 'sql', 'css'];
  const folder = [];
  for (let i = 0; i < 150; i++) folder.push(fakeFile(`proj/src/${'sub/'.repeat(i % 6)}mod${i}.${langs[i % langs.length]}`, `const v${i} = ${i};`));
  folder.push(fakeFile('proj/server/api.js', "import express from 'express'; const app = express(); app.listen(3000)"));
  const folderCorpus = await loadFromFileList(folder);
  t.eq('folder: caps at 80 files', folderCorpus.files.length, 80);
  t.ok('folder: reports the file-count drop honestly', folderCorpus.notes.some((n) => /file-count limit/.test(n)));
  t.ok('folder: deep nested paths preserved', folderCorpus.files.some((f) => f.path.includes('sub/sub/')));
  await t.within('folder: analyze 80 mixed-language files is fast', 3000, async () => {
    const r = analyze(folderCorpus); t.ok('folder: valid verdict', VERDICTS.has(r.verdict.key));
  });
  // the express server file ranks high (server/ path) so it survives the cap and is seen
  t.ok('folder: high-signal backend survives the cap', analyze(folderCorpus).conditions.find((c) => c.id === 'host').status !== 'pass');

  // ===== (2) different GIT REPO shapes ======================================
  // monorepo + subdir filter
  mockGitHub({
    tree: [
      { type: 'blob', path: 'packages/web/app.js', size: 20 },
      { type: 'blob', path: 'packages/api/server.js', size: 60 },
      { type: 'tree', path: 'packages', size: 0 },
    ],
    contents: { 'packages/web/app.js': 'const x=1', 'packages/api/server.js': "import express from 'express'; app.listen(3000)" },
  });
  const sub = await loadFromGitHub('https://github.com/o/r/tree/main/packages/web');
  t.ok('repo subdir filter: only packages/web', sub.files.every((f) => f.path.startsWith('packages/web')));
  t.eq('repo subdir: source label', sub.source, 'github');

  // big tree -> caps + honest note
  const bigTree = Array.from({ length: 200 }, (_, i) => ({ type: 'blob', path: `f${i}.js`, size: 30 }));
  const bigContents = Object.fromEntries(bigTree.map((n) => [n.path, 'const x=1']));
  mockGitHub({ tree: bigTree, contents: bigContents });
  const bigRepo = await loadFromGitHub('o/r');
  t.eq('big repo caps at 80', bigRepo.files.length, 80);
  t.ok('big repo notes the dropped files', bigRepo.notes.some((n) => /not read|not analyzed/i.test(n)));

  // symlink/submodule nodes (no numeric size) are dropped, not fetched
  mockGitHub({ tree: [{ type: 'blob', path: 'real.js', size: 10 }, { type: 'blob', path: 'link.js' /* no size */ }], contents: { 'real.js': 'const x=1' } });
  const syml = await loadFromGitHub('o/r');
  t.ok('symlink node (no size) excluded', !syml.files.some((f) => f.path === 'link.js'));
  t.ok('real file still read', syml.files.some((f) => f.path === 'real.js'));

  // binary-heavy repo -> non-code skipped note
  mockGitHub({ tree: [{ type: 'blob', path: 'a.js', size: 5 }, { type: 'blob', path: 'img.png', size: 99 }, { type: 'blob', path: 'vid.mp4', size: 99 }], contents: { 'a.js': 'x' } });
  const bin = await loadFromGitHub('o/r');
  t.ok('binary repo: only code file read', bin.files.length === 1);
  t.ok('binary repo: notes non-code skipped', bin.notes.some((n) => /non-code/i.test(n)));

  // empty repo -> zero files, no throw
  mockGitHub({ tree: [] });
  const empty = await loadFromGitHub('o/r');
  t.eq('empty repo: 0 files', empty.files.length, 0);
  t.notThrows('analyze of empty repo corpus does not throw', () => analyze(empty));

  // 404 + rate-limit -> helpful, distinct errors
  mockGitHub({ repoStatus: 404 });
  await t.notThrowsAsync('404 surfaces (caught)', async () => { try { await loadFromGitHub('o/r'); t.ok('404 should throw', false); } catch (e) { t.includes('404 message mentions not found/private', e.message, 'not found'); } });
  mockGitHub({ rateLimited: true });
  await t.notThrowsAsync('rate-limit surfaces (caught)', async () => { try { await loadFromGitHub('o/r'); t.ok('rate-limit should throw', false); } catch (e) { t.includes('rate-limit message mentions token', e.message.toLowerCase(), 'token'); } });
  // bad URL never even calls fetch
  await t.notThrowsAsync('non-github URL rejected', async () => { try { await loadFromGitHub('https://evil.com/o/r'); t.ok('bad url should throw', false); } catch (e) { t.truthy('bad url throws', e); } });

  globalThis.fetch = realFetch;

  // ===== (3) MASSIVE vs tiny ===============================================
  const massive = await loadFromFileList([fakeFile('huge.js', 'x'.repeat(3 * 1024 * 1024))]);
  t.ok('massive single file is truncated', massive.files[0].truncated === true);
  t.ok('massive file capped at 256KB', massive.files[0].text.length <= 256 * 1024);
  await t.within('massive file analyze is fast', 3000, async () => analyze(massive));
  const tiny = loadFromPaste('x');
  t.notThrows('tiny one-char paste analyzes', () => analyze(tiny));
  await t.within('5000-line file analyze is fast', 3000, async () => analyze(corpusOf([{ path: 'big.js', text: Array.from({ length: 5000 }, (_, i) => `const x${i} = ${i};`).join('\n') }])));

  // ===== (4) complex WORKBOOK vs trivial CSV ===============================
  const trivialCsv = await loadFromSpreadsheet(fakeFile('mini.csv', 'a,b\n1,2'));
  t.ok('trivial csv -> lane1', analyze(trivialCsv).verdict.key === 'lane1');
  // a complex CSV: many columns, quoted fields with embedded commas/newlines, an injection cell
  const cols = Array.from({ length: 60 }, (_, i) => `col${i}`).join(',');
  const rows = Array.from({ length: 500 }, (_, r) => Array.from({ length: 60 }, (_, c) => (c === 3 ? '"a,b\nc"' : r + '' + c)).join(',')).join('\n');
  const complexCsv = csvToArtifacts(cols + '\n' + rows + '\n=cmd|\'/c calc\'!A1', 'complex.csv');
  t.truthy('complex csv: data artifact present', complexCsv.some((f) => f.path.startsWith('data/')));
  t.truthy('complex csv: injection cell flagged', complexCsv.some((f) => /injection/.test(f.path)));
  await t.within('complex csv parse is fast', 2000, async () => csvToArtifacts(rows, 'c.csv'));
  // a plain data CSV with a scary-looking value is still just data, not a shipping backend
  const dataWithWords = await loadFromSpreadsheet(fakeFile('notes.csv', 'note\n"call fetch later"\n"insert the widget"'));
  t.ok('data CSV with prose does not become a backend', analyze(dataWithWords).conditions.find((c) => c.id === 'host').status === 'pass');
  // corrupt workbook degrades gracefully (mock JSZip that fails)
  await t.notThrowsAsync('corrupt xlsx -> graceful, no throw', async () => {
    const c = await loadFromSpreadsheet(fakeFile('x.xlsx', 'not a zip'), () => {}, { JSZip: { async loadAsync() { throw new Error('bad'); } } });
    t.truthy('corrupt xlsx still returns a corpus', c && c.files);
  });

  return t.st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { printResult } = await import('./_harness.mjs');
  printResult(await run());
}
