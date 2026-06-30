// sources.js — turn any input (GitHub URL, uploaded files/folder, .zip, or pasted
// text) into a normalized corpus the classifier can analyze:
//
//   { source, label, files: [{ path, text, bytes, truncated }], meta, notes }
//
// All of this runs in the browser. The only outbound network call is to the
// GitHub API / raw.githubusercontent.com when the user supplies a repo URL —
// that single host is the analyzer's allowlisted dependency.

// File types we will actually read as text (source + config + docs).
const TEXT_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini',
  'env', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'cs', 'sh', 'bash', 'ps1',
  'sql', 'graphql', 'gql', 'md', 'markdown', 'txt', 'csv', 'tsv', 'xml', 'r', 'ipynb',
  'cfg', 'conf', 'dockerfile', 'tf', 'tfvars', 'gradle', 'properties', 'bicep',
  // Spreadsheet-extracted artifacts (so they survive a zip/folder upload too).
  'bas', 'cls', 'frm', 'vba', 'm', 'pq', 'formulas', 'defnames', 'xllinks', 'xlm',
]);

// Filenames (no extension) that are meaningful config/signal carriers.
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', '.env', '.gitignore', '.npmrc',
  'requirements.txt', 'pipfile', 'gemfile', 'staticwebapp.config.json',
]);

// Directories that are noise — never analyze these.
const IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor',
  '__pycache__', '.venv', 'venv', 'coverage', '.cache', 'target', 'bin', 'obj',
  '.idea', '.vscode', 'site-packages',
];

const MAX_FILES = 80;          // cap how many files we read
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MB total

function ext(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base.slice(1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

function isIgnored(path) {
  const parts = path.toLowerCase().split('/');
  return parts.some((p) => IGNORE_DIRS.includes(p));
}

function isTextual(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return true;
  if (TEXT_NAMES.has(base)) return true;
  return TEXT_EXT.has(ext(path));
}

// Rank files so the most signal-rich are read first when we hit the cap.
function signalRank(path) {
  const p = path.toLowerCase();
  let score = 0;
  if (/(^|\/)package\.json$/.test(p)) score += 100;
  if (/(^|\/)requirements\.txt$|(^|\/)pipfile|(^|\/)pyproject\.toml$/.test(p)) score += 95;
  if (/staticwebapp\.config\.json$/.test(p)) score += 90;
  if (/(^|\/)dockerfile|docker-compose/.test(p)) score += 80;
  if (/\.env/.test(p)) score += 80;
  if (/(server|api|backend|functions?|routes?|controllers?)\//.test(p)) score += 70;
  if (/index\.(html|js|ts|jsx|tsx)$/.test(p)) score += 60;
  if (/\.(html|js|mjs|ts|jsx|tsx|py|sql)$/.test(p)) score += 30;
  if (/(^|\/)readme/i.test(p)) score += 25;
  if (/\.(md|txt|csv|json|ya?ml)$/.test(p)) score += 10;
  // Shallow files slightly preferred (entry points tend to be near root).
  score -= (p.split('/').length - 1) * 2;
  return score;
}

function normalizeCorpus(files, partial) {
  return {
    files,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function parseGitHubUrl(input) {
  const url = String(input || '').trim();
  // Accept: https://github.com/owner/repo[/tree|blob/branch/sub/dir], git@, or owner/repo.
  // The github.com host is anchored so look-alikes (notgithub.com, evil.com/github.com/...)
  // are rejected. Both /tree/<branch> and /blob/<branch> are recognized.
  let m = url.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.+?))?)?\/?(?:[#?].*)?$/i);
  if (!m) m = url.match(/^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i);
  if (!m) {
    const b = url.match(/^([\w.-]+)\/([\w.-]+)$/); // bare owner/repo
    if (b) return { owner: b[1], repo: b[2].replace(/\.git$/, ''), branch: null, subdir: '' };
    return null;
  }
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ''),
    branch: m[3] || null,
    subdir: (m[4] || '').replace(/\/$/, ''),
  };
}

async function ghJson(url, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // 403/429 mean a rate limit. The PRIMARY (60/hr) limit sets
    // x-ratelimit-remaining:0; a SECONDARY (abuse) limit — tripped by bursts of
    // concurrent requests — returns 403 with a Retry-After header and/or a
    // "rate limit" body but NO remaining:0. Recognize both, so a real rate limit
    // surfaces the actionable "add a token" message rather than the generic
    // "couldn't reach that repo" (which sent users chasing a network ghost).
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = res.headers.get('retry-after');
      let body = '';
      try { body = await res.clone().text(); } catch { /* body may be unreadable */ }
      if (remaining === '0' || retryAfter || /rate limit/i.test(body)) {
        throw new Error('GitHub API rate limit reached. Add a personal access token to continue, or upload the files directly.');
      }
      // A non-rate-limit 403 means the repo is private / the token lacks access.
      throw new Error('Repository not found, or it is private. Add a token, or upload the files directly.');
    }
    if (res.status === 404) throw new Error('Repository not found, or it is private. Add a token, or upload the files directly.');
    throw new Error(`GitHub request failed (${res.status}).`);
  }
  return res.json();
}

export async function loadFromGitHub(input, token, onProgress = () => {}) {
  const parsed = parseGitHubUrl(input);
  if (!parsed) throw new Error('That does not look like a GitHub URL. Try https://github.com/owner/repo');
  const { owner, repo, subdir } = parsed;

  onProgress(`Reading ${owner}/${repo}…`);
  const meta = await ghJson(`https://api.github.com/repos/${owner}/${repo}`, token);
  const branch = parsed.branch || meta.default_branch || 'main';

  onProgress('Listing files…');
  const tree = await ghJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );

  let blobs = (tree.tree || []).filter((n) => n.type === 'blob');
  if (subdir) blobs = blobs.filter((n) => n.path.startsWith(subdir + '/') || n.path === subdir);

  // Require a known, in-bounds byte size (drops symlink/submodule edge nodes that could
  // otherwise trigger an unbounded fetch). Rank each surviving path ONCE (not inside the
  // sort comparator, which would re-evaluate ~10 regexes O(n log n) times).
  // textualAll = the isTextual code-file set BEFORE the size/symlink guard, so we can
  // count CODE files dropped by the guard separately from true non-text files.
  const textualAll = blobs.filter((n) => !isIgnored(n.path) && isTextual(n.path));
  const textual = textualAll.filter((n) => typeof n.size === 'number' && n.size <= MAX_FILE_BYTES);
  const candidates = textual
    .map((n) => ({ n, rank: signalRank(n.path) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_FILES)
    .map((x) => x.n);

  // Fetch raw file bodies with bounded concurrency (browsers allow ~6 connections/host),
  // rather than one blocking round-trip at a time. Results are stored by index so the
  // surviving file SET and ORDER stay identical to the old sequential walk.
  //
  // Public repos read from raw.githubusercontent.com (a CDN): it is NOT bound by the
  // 60/hr core-API limit and tolerates the concurrent burst, so a whole repo costs just
  // the 2 API calls above (meta + tree) instead of one-per-file. Pulling every file
  // through the rate-limited Contents API used to exhaust the limit / trip GitHub's
  // secondary (abuse) limiter, surfacing as "couldn't reach that repo". A token means a
  // private repo, which the raw CDN can't authenticate — those go through the
  // authenticated Contents API (5000/hr, ample for the file cap).
  // Code files dropped by the file-count cap, PLUS code files dropped by the size/symlink
  // guard (textualAll - textual). Both are real code files we could not read — folding the
  // size-dropped set in here keeps them out of the "non-code" note (FIX-23).
  let truncatedCount = Math.max(0, textual.length - MAX_FILES) + (textualAll.length - textual.length);
  const CONCURRENCY = 6;
  const results = new Array(candidates.length);
  let nextIdx = 0, done = 0;
  async function worker() {
    for (let i = nextIdx++; i < candidates.length; i = nextIdx++) {
      const node = candidates[i];
      try {
        const encPath = node.path.split('/').map(encodeURIComponent).join('/');
        const res = token
          ? await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${encPath}?ref=${encodeURIComponent(branch)}`,
            { headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}` } },
          )
          : await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encPath}`);
        if (res.ok) {
          let text = await res.text();
          let truncated = false;
          if (text.length > MAX_FILE_BYTES) { text = text.slice(0, MAX_FILE_BYTES); truncated = true; }
          results[i] = { path: node.path, text, bytes: node.size || text.length, truncated };
        }
      } catch { /* skip unreadable file */ }
      onProgress(`Reading files… ${++done}/${candidates.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  // Assemble in priority order under the same per-corpus byte budget; count anything
  // dropped (failed fetch or over budget) so the note stays honest.
  const files = [];
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) { truncatedCount++; continue; }
    if (total >= MAX_TOTAL_BYTES) { truncatedCount += results.slice(i).filter(Boolean).length; break; }
    total += r.text.length;
    files.push(r);
  }

  const notes = [];
  if (truncatedCount > 0) notes.push(`${truncatedCount} more code file(s) were not read (file/size limit or a failed fetch).`);
  // Strictly the true non-text files (NOT textual code files dropped by the size/symlink
  // guard — those are accounted for in truncatedCount above) (FIX-23).
  const nonCode = blobs.filter((n) => !isIgnored(n.path) && !isTextual(n.path)).length;
  if (nonCode > 0) notes.push(`${nonCode} non-code file(s) were skipped.`);

  return normalizeCorpus(files, {
    source: 'github',
    label: `${owner}/${repo}`,
    meta: {
      owner, repo, branch, subdir,
      description: meta.description || '',
      language: meta.language || '',
      htmlUrl: meta.html_url,
      stars: meta.stargazers_count,
    },
    notes,
  });
}

// ---------------------------------------------------------------------------
// Uploaded files / folders
// ---------------------------------------------------------------------------

async function readFileAsText(file) {
  // Cap oversized files so one huge blob can't blow the time/memory budget. (Binary files
  // are already excluded upstream by the isTextual extension allowlist.)
  if (file.size > MAX_FILE_BYTES) {
    const slice = await file.slice(0, MAX_FILE_BYTES).text();
    return { text: slice, truncated: true };
  }
  return { text: await file.text(), truncated: false };
}

export async function loadFromFileList(fileList, onProgress = () => {}) {
  const all = Array.from(fileList);
  // Valid (textual, non-ignored) entries ranked — capture the count BEFORE the MAX_FILES
  // slice so we can honestly report how many valid files the file-count cap dropped (FIX-09).
  const ranked = all
    .map((f) => ({ f, path: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }))
    .filter(({ path }) => !isIgnored(path) && isTextual(path))
    .map((x) => ({ ...x, rank: signalRank(x.path) }))
    .sort((a, b) => b.rank - a.rank);
  const candidates = ranked.slice(0, MAX_FILES);
  // Dropped purely because of the file-count cap (valid files we never even attempt).
  const droppedByFileCount = Math.max(0, ranked.length - candidates.length);

  const files = [];
  let total = 0;
  let droppedByBudget = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (total >= MAX_TOTAL_BYTES) { droppedByBudget = candidates.length - i; break; }
    const { f, path } = candidates[i];
    onProgress(`Reading files… ${i + 1}/${candidates.length}`);
    try {
      const { text, truncated } = await readFileAsText(f);
      total += text.length;
      files.push({ path, text, bytes: f.size, truncated });
    } catch { /* skip */ }
  }

  const rootName = (all[0]?.webkitRelativePath || '').split('/')[0];
  const notes = [];
  // Strictly the non-textual / ignored input entries — NOT valid files dropped by a cap.
  const nonText = all.filter((f) => {
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    return !(!isIgnored(path) && isTextual(path));
  }).length;
  if (droppedByFileCount > 0) notes.push(`${droppedByFileCount} code file(s) were not analyzed (file-count limit).`);
  if (droppedByBudget > 0) notes.push(`${droppedByBudget} file(s) were not read (4MB total limit).`);
  if (nonText > 0) notes.push(`${nonText} non-text/ignored file(s) were skipped.`);

  return normalizeCorpus(files, {
    source: 'upload',
    label: rootName || (all.length === 1 ? all[0].name : `${all.length} files`),
    meta: { fileCount: all.length },
    notes,
  });
}

// ---------------------------------------------------------------------------
// Zip archive (uses the vendored global JSZip)
// ---------------------------------------------------------------------------

export async function loadFromZip(file, onProgress = () => {}) {
  if (typeof JSZip === 'undefined') throw new Error('Zip support is unavailable (JSZip failed to load).');
  onProgress('Unpacking archive…');
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((e) => !e.dir);

  // Valid (textual, non-ignored) entries ranked — capture the count BEFORE the MAX_FILES
  // slice so we can honestly report how many valid files the file-count cap dropped (FIX-09).
  const ranked = entries
    .map((e) => ({ e, path: e.name.replace(/\\/g, '/') }))
    .filter(({ path }) => !isIgnored(path) && isTextual(path))
    .map((x) => ({ ...x, rank: signalRank(x.path) }))
    .sort((a, b) => b.rank - a.rank);
  const candidates = ranked.slice(0, MAX_FILES);
  // Dropped purely because of the file-count cap (valid files we never even attempt).
  const droppedByFileCount = Math.max(0, ranked.length - candidates.length);

  const files = [];
  let total = 0;
  let droppedByBudget = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (total >= MAX_TOTAL_BYTES) { droppedByBudget = candidates.length - i; break; }
    const { e, path } = candidates[i];
    onProgress(`Reading files… ${i + 1}/${candidates.length}`);
    try {
      let text = await e.async('string');
      let truncated = false;
      if (text.length > MAX_FILE_BYTES) { text = text.slice(0, MAX_FILE_BYTES); truncated = true; }
      total += text.length;
      files.push({ path, text, bytes: text.length, truncated });
    } catch { /* skip */ }
  }

  // Strip a common top-level folder from the label if present.
  const top = candidates[0]?.path.split('/')[0] || file.name.replace(/\.zip$/i, '');
  const notes = [];
  // Strictly the non-textual / ignored input entries — NOT valid files dropped by a cap.
  const nonText = entries.filter((e) => {
    const path = e.name.replace(/\\/g, '/');
    return !(!isIgnored(path) && isTextual(path));
  }).length;
  if (droppedByFileCount > 0) notes.push(`${droppedByFileCount} code file(s) were not analyzed (file-count limit).`);
  if (droppedByBudget > 0) notes.push(`${droppedByBudget} file(s) were not read (4MB total limit).`);
  if (nonText > 0) notes.push(`${nonText} non-text/ignored file(s) were skipped.`);

  return normalizeCorpus(files, {
    source: 'zip',
    label: top,
    meta: { entryCount: entries.length },
    notes,
  });
}

// ---------------------------------------------------------------------------
// Pasted code
// ---------------------------------------------------------------------------

// Guess a sensible filename (with extension) for a pasted blob from its first chunk only —
// the language signature is always near the top, so we never scan a multi-MB paste here.
export function guessPasteName(text, filename = 'pasted-snippet') {
  if (/\.\w+$/.test(filename)) return filename;
  const head = String(text || '').slice(0, 4096);
  const guessHtml = /<!doctype html|<html|<script|<\/div>/i.test(head);
  const guessPy = /^\s*(import |from .+ import|def |class )/m.test(head);
  return `${filename}.${guessHtml ? 'html' : guessPy ? 'py' : 'js'}`;
}

export function loadFromPaste(text, filename = 'pasted-snippet') {
  const t = String(text || ''); // coerce once, then use everywhere (no .length off a raw null)
  const path = guessPasteName(t, filename);
  return normalizeCorpus(
    [{ path, text: t, bytes: t.length, truncated: false }],
    { source: 'paste', label: 'Pasted snippet', meta: {}, notes: [] },
  );
}

// Build a corpus from one or more pasted snippets — each becomes its own file. This backs
// the input bar's "large paste → attachment" path, where a user can stack several pastes
// before checking. Generated paths are de-duplicated so two unnamed snippets don't collide.
export function loadFromPastes(items) {
  const list = (Array.isArray(items) ? items : [items]).filter((it) => it && String(it.text || '').length);
  if (!list.length) return normalizeCorpus([], { source: 'paste', label: 'Pasted snippet', meta: {}, notes: [] });
  const seen = new Set();
  const files = list.map((it, i) => {
    let path = guessPasteName(it.text, it.name || `pasted-${i + 1}`);
    if (seen.has(path)) {
      const dot = path.lastIndexOf('.');
      const stem = dot > 0 ? path.slice(0, dot) : path;
      const extn = dot > 0 ? path.slice(dot) : '';
      let n = 2; while (seen.has(`${stem}-${n}${extn}`)) n++;
      path = `${stem}-${n}${extn}`;
    }
    seen.add(path);
    const t = String(it.text);
    return { path, text: t, bytes: t.length, truncated: false };
  });
  return normalizeCorpus(files, {
    source: 'paste',
    label: files.length === 1 ? 'Pasted snippet' : `${files.length} pasted snippets`,
    meta: {}, notes: [],
  });
}
