// context.js — turn a loaded corpus into a compact, model-ready code digest.
//
// The local model has a finite, speed-sensitive context window, so we can't
// feed it the whole corpus. This picks the most signal-rich files (the same
// instinct sources.js uses), trims each, and assembles a budgeted digest the
// advisor drops into its prompt. Nothing here is prompt- or vendor-specific —
// it just produces the {{CODE}} text — so it's reused whatever the model is.

const CHAR_BUDGET = 22000;   // ~6k tokens of code — enough to judge, fast to run
const PER_FILE_CAP = 6000;   // no single file may dominate the digest
const MAX_FILES = 18;        // breadth over depth — see many files, not one whole one

// Cheap "is this a built/minified bundle we can't really read?" guard, so a
// vendored blob can't eat the whole budget.
function isMinified(text) {
  if (!text) return true;
  const lines = text.split('\n');
  const maxLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return maxLine > 1500 || (text.length > 2000 && text.length / lines.length > 400);
}

// Rank files so the advisor sees what actually carries governance signal first:
// entry points, server/api code, data/config, then docs. Mirrors sources.js's
// signalRank intent but tuned for "what helps a human-style judgment".
function rank(path) {
  const p = path.toLowerCase();
  let s = 0;
  if (/(^|\/)readme/i.test(p)) s += 60;                         // intent in prose
  if (/(^|\/)package\.json$|requirements\.txt$|pyproject\.toml$/.test(p)) s += 50;
  if (/(server|api|backend|functions?|routes?|controllers?|jobs?|worker)\b/.test(p)) s += 45;
  if (/index\.(html|js|ts|jsx|tsx)$|main\.(py|js|ts)$|app\.(py|js|ts)$/.test(p)) s += 40;
  if (/\.(py|js|mjs|ts|jsx|tsx|go|rb|php|java|cs|sql)$/.test(p)) s += 25;
  if (/\.(md|txt|ya?ml|json|toml|env|ini|cfg)$/.test(p)) s += 8;
  s -= (p.split('/').length - 1) * 2;                            // prefer shallow
  return s;
}

// Build the digest string + a manifest of what was (and wasn't) included, so the
// advisor can honestly tell the model "this is a partial view" when it is.
export function buildCodeDigest(corpus, { charBudget = CHAR_BUDGET } = {}) {
  const files = Array.isArray(corpus && corpus.files) ? corpus.files : [];
  const ranked = files
    .map((f) => ({ f, score: rank((f && f.path) || ''), minified: isMinified((f && f.text) || '') }))
    .sort((a, b) => b.score - a.score);

  const parts = [];
  const included = [];
  let used = 0;
  let omitted = 0;

  for (const { f, minified } of ranked) {
    if (included.length >= MAX_FILES || used >= charBudget) { omitted++; continue; }
    let body = String((f && f.text) || '');
    if (minified) { omitted++; continue; }               // unreadable bundle — skip
    let trimmed = false;
    if (body.length > PER_FILE_CAP) { body = body.slice(0, PER_FILE_CAP); trimmed = true; }
    const remaining = charBudget - used;
    if (body.length > remaining) { body = body.slice(0, remaining); trimmed = true; }
    if (!body.trim()) { omitted++; continue; }
    const header = `\n----- FILE: ${(f && f.path) || ''}${trimmed ? '  (truncated)' : ''} -----\n`;
    parts.push(header + body);
    used += header.length + body.length;
    included.push((f && f.path) || '');
  }

  // Fallback: if every ranked file tripped the isMinified guard (common for a
  // single-/few-file POC that happens to be one long line), the digest would
  // collapse to '(no readable source files)' and leave the advisor blind. Rather
  // than that, include the single top-ranked non-empty file, trimmed to the cap.
  if (included.length === 0) {
    for (const { f } of ranked) {
      const text = String((f && f.text) || '');
      if (!text.trim()) continue;
      const path = (f && f.path) || '';
      const body = text.slice(0, PER_FILE_CAP);
      const header = `\n----- FILE: ${path}  (truncated) -----\n`;
      parts.push(header + body);
      used += header.length + body.length;
      included.push(path);
      break;
    }
  }

  const meta = (corpus && corpus.meta) || {};
  const repoMeta = meta.repoMeta || {};
  const descBits = [];
  if (meta.label) descBits.push(`Name: ${meta.label}`);
  if (repoMeta.description) descBits.push(`Description: ${repoMeta.description}`);
  if (repoMeta.language) descBits.push(`Primary language: ${repoMeta.language}`);
  const repoDesc = descBits.join('\n') || 'No description provided.';

  return {
    code: parts.join('\n') || '(no readable source files)',
    repoDesc,
    manifest: { included, omitted, total: files.length, chars: used, partial: omitted > 0 },
  };
}
