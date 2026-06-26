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
  'sql', 'graphql', 'gql', 'md', 'markdown', 'txt', 'csv', 'xml', 'r', 'ipynb',
  'cfg', 'conf', 'dockerfile', 'tf', 'tfvars', 'gradle', 'properties', 'bicep',
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
  // Accept: https://github.com/owner/repo[/tree/branch/sub/dir], git@, or owner/repo
  let m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+))?)?/i);
  if (!m) {
    m = url.match(/^([\w.-]+)\/([\w.-]+)$/); // bare owner/repo
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), branch: null, subdir: '' };
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
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && remaining === '0') {
      throw new Error('GitHub API rate limit reached. Add a personal access token to continue, or upload the files directly.');
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

  const candidates = blobs
    .filter((n) => !isIgnored(n.path) && isTextual(n.path) && (n.size || 0) <= MAX_FILE_BYTES)
    .sort((a, b) => signalRank(b.path) - signalRank(a.path))
    .slice(0, MAX_FILES);

  const files = [];
  let total = 0;
  let truncatedCount = blobs.length - candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const node = candidates[i];
    if (total >= MAX_TOTAL_BYTES) {
      truncatedCount += candidates.length - i;
      break;
    }
    onProgress(`Reading files… ${i + 1}/${candidates.length}`);
    try {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${node.path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(rawUrl);
      if (!res.ok) continue;
      let text = await res.text();
      let truncated = false;
      if (text.length > MAX_FILE_BYTES) { text = text.slice(0, MAX_FILE_BYTES); truncated = true; }
      total += text.length;
      files.push({ path: node.path, text, bytes: node.size || text.length, truncated });
    } catch { /* skip unreadable file */ }
  }

  const notes = [];
  if (truncatedCount > 0) notes.push(`${truncatedCount} additional/large/binary file(s) were not read.`);

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
  // Skip obviously-binary or oversized files quickly.
  if (file.size > MAX_FILE_BYTES) {
    const slice = await file.slice(0, MAX_FILE_BYTES).text();
    return { text: slice, truncated: true };
  }
  return { text: await file.text(), truncated: false };
}

export async function loadFromFileList(fileList, onProgress = () => {}) {
  const all = Array.from(fileList);
  const candidates = all
    .map((f) => ({ f, path: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }))
    .filter(({ path }) => !isIgnored(path) && isTextual(path))
    .sort((a, b) => signalRank(b.path) - signalRank(a.path))
    .slice(0, MAX_FILES);

  const files = [];
  let total = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (total >= MAX_TOTAL_BYTES) break;
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
  const skipped = all.length - candidates.length;
  if (skipped > 0) notes.push(`${skipped} non-text/ignored file(s) were not analyzed.`);

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

  const candidates = entries
    .map((e) => ({ e, path: e.name.replace(/\\/g, '/') }))
    .filter(({ path }) => !isIgnored(path) && isTextual(path))
    .sort((a, b) => signalRank(b.path) - signalRank(a.path))
    .slice(0, MAX_FILES);

  const files = [];
  let total = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (total >= MAX_TOTAL_BYTES) break;
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
  const skipped = entries.length - candidates.length;
  if (skipped > 0) notes.push(`${skipped} non-text/ignored file(s) were not analyzed.`);

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

export function loadFromPaste(text, filename = 'pasted-snippet') {
  const guessHtml = /<!doctype html|<html|<script|<\/div>/i.test(text);
  const guessPy = /^\s*(import |from .+ import|def |class )/m.test(text);
  const path = /\.\w+$/.test(filename)
    ? filename
    : `${filename}.${guessHtml ? 'html' : guessPy ? 'py' : 'js'}`;
  return normalizeCorpus(
    [{ path, text: String(text || ''), bytes: text.length, truncated: false }],
    { source: 'paste', label: 'Pasted snippet', meta: {}, notes: [] },
  );
}
