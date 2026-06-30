// classify.js — turn raw signal matches into a governance verdict.
//
// It follows the playbook's two-step triage exactly:
//   STEP 1  set the risk tier  (Use / Register / Approve)         — the tier always wins
//   STEP 2  pick the lane      (Lane 1 only if every §5 holds)    — else Lane 2
//
// Some inputs to STEP 1 are NOT knowable from code (is the data really
// Client/Fund? does anyone else rely on it?). For those we auto-detect a
// sensible default from the signals, mark them as assumptions, and let the
// caller override them — the verdict re-resolves instantly. Code-certain
// signals (a direct AI call, a third-party script, a server runtime) decide
// on their own.

import { scanCorpus } from './scan.js';

// Re-derived, tightened detectors for the dimensions that need calibration so
// a weak keyword can't over-escalate a benign utility.
// Strong entity terms fire on their own; weak terms ("restricted" as a CSS
// class, "portfolio" on a marketing page) need a real data context.
const STRONG_ENTITY = /\b(investors?|LPs?|GPs?|capital\s*accounts?|capital\s*calls?|subscriptions?|redemptions?|custodian|ledger|mandates?|fund\s*(nav|id|name|position|holdings?)|client[_\s-]?(name|id|account|holding|portfolio)|SSN|EIN|TIN|account\s*number|routing\s*number|PII|PHI|MNPI|material\s*non[-\s]public)\b/i;
// NAV/AUM are case-sensitive (real ones are uppercase) and must not be a tag or
// word fragment — so the HTML <nav> element and "navbar" don't read as data.
const STRONG_ACRONYM = /(?<![<\/\w])(NAV|AUM)(?![\w])/;
// "restricted"/"confidential" are data-classification words; portfolio/holdings
// are too generic to escalate alone (a real holdings tool trips STRONG_ENTITY via
// fund/investor/NAV anyway), so they're deliberately NOT weak scope terms.
const WEAK_INTENT = /\b(restricted|confidential)\b/i;
const SCOPE_BENIGN = /[.#][\w-]*(restricted|confidential)|class\s*=\s*['"][^'"]*(restricted|confidential)|(restricted|confidential)[\w-]*\s*[:{]|data-[\w-]*=\s*['"][^'"]*(restricted|confidential)/i;
// A POST to an external API is only a *write* when its path looks like one —
// POST is also how AI / GraphQL / search APIs are queried, so method alone
// can't decide. PUT/PATCH/DELETE are unambiguous writes (handled by METHOD_WRITE).
// Collection nouns (customers/users/accounts/…) are record writes too; /graphql, /search,
// /query are deliberately NOT here (a POST to them is a query, not a write).
const WRITE_PATH = '(records?|create|update|save|insert|write|entries|ledger|payments?|sign[-_]?off|submit|upload|transactions?|invoices?|allocations?|customers?|users?|accounts?|contacts?|orders?|clients?|members?|leads?|profiles?)';
const WRITE_PATH_RE = new RegExp(`/${WRITE_PATH}\\b`, 'i');
const GPFS_HOST_RE = /^https?:\/\/([a-z0-9.-]*\.)?gpfundsolutions\.com/i;
// A fetch/axios call whose first argument is a quoted URL, captured ATOMICALLY as a single
// bounded run up to the matching quote (a `\1` backreference to the opening quote), with a
// method:POST within the call. We then test the captured URL for a write-y path in JS. This
// replaces the old MUTATING_FETCH_EXTERNAL/RELATIVE_POST_WRITE, whose twin unbounded `[^'"`]*`
// runs straddling the WRITE_PATH alternation backtracked catastrophically (~28s on one 256KB
// quote-less file). Linear here: the URL body is one bounded class with no overlap.
const FETCH_POST_CALL = /\b(?:fetch|axios)\s*\(\s*(['"`])(https?:\/\/[^'"`]{0,2048}|\/[^'"`]{0,2048})\1\s*,[^;]{0,300}?\bmethod\b\s*:\s*['"`]post/gi;
function hasFetchPostWrite(clean) {
  FETCH_POST_CALL.lastIndex = 0;
  let m;
  while ((m = FETCH_POST_CALL.exec(clean)) !== null) {
    const url = m[2];
    if (url[0] === '/') {
      if (/^\/api\/chat\b/i.test(url)) continue;   // the approved same-origin proxy is not a write
      if (WRITE_PATH_RE.test(url)) return true;
    } else {
      if (GPFS_HOST_RE.test(url)) continue;        // same-company host is allowlisted
      if (WRITE_PATH_RE.test(url)) return true;
    }
  }
  return false;
}
const XHR_MUTATE_EXTERNAL = /\.open\s*\(\s*['"`](put|patch|delete)['"`]\s*,\s*['"`]https?:\/\//i;
const SHARED_PATH_WRITE = /(\.save|writefile\w*|to_csv|write_csv|wb\.save|savefig|\.to_excel)\s*\(\s*['"`](\\\\|\/\/)[a-z0-9._-]+[\\/]/i;
// ORM-chain writes (Drizzle/Kysely .update(t).set(…)) and Go (gorm / http.NewRequest).
const ORM_CHAIN_WRITE = /\.(update|insert|delete)\s*\(\s*\w+\s*\)\s*\.(set|values|where)\s*\(|\.(insert|update|delete)into\s*\(/i;
const GO_WRITE = /\b(db|tx)\.(Create|Save|Updates?|Delete|FirstOrCreate)\s*\(|\bdb\.Model\([^)]*\)\.(Update|Save|Delete)|gorm\.io|http\.NewRequest\s*\(\s*['"`](put|patch|delete)['"`]/i;

// Restricted-data detection: a strong entity anywhere, or "restricted"/
// "confidential" in a non-CSS / non-markup line. Operates on comment-stripped text.
function detectRestricted(cleanFiles) {
  // Normalize identifier separators so snake_case / kebab-case entities (investor_capital_account,
  // fund-nav) read the same as their spaced forms. STRONG_ACRONYM stays case-sensitive on the
  // raw text (real NAV/AUM are uppercase; fund_nav is lowercase and matched via STRONG_ENTITY).
  const norm = (s) => s.replace(/[_-]+/g, ' ');
  if (cleanFiles.some((f) => STRONG_ENTITY.test(norm(f.clean)) || STRONG_ACRONYM.test(f.clean))) return true;
  for (const f of cleanFiles) {
    const e = (f.path.split('.').pop() || '').toLowerCase();
    if (['css', 'scss', 'sass', 'less'].includes(e)) continue; // stylesheet "restricted" is never data
    for (const ln of f.clean.split('\n')) {
      if (WEAK_INTENT.test(ln) && !SCOPE_BENIGN.test(ln)) return true;
    }
  }
  return false;
}

// Heuristic: is this file a minified/built bundle (so we can't really read it)?
function isMinified(text) {
  if (!text) return false;
  const lines = text.split('\n');
  const maxLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return maxLine > 1500 || (text.length > 2000 && text.length / lines.length > 400);
}
// Host-label runs are length-BOUNDED ({1,40}) so testing this over a large file body can't
// backtrack quadratically on a long [a-z0-9-] run (real subdomain labels are short anyway).
const VENDOR_HOST = /(api\.(anthropic|openai|cohere|mistral|groq)\.|[a-z0-9-]{1,40}\.openai\.azure\.com|openai\.azure\.com|generativelanguage\.googleapis\.com|api-inference\.huggingface\.co|api\.replicate\.com|bedrock(-runtime)?\.[a-z0-9-]{1,40}\.amazonaws\.com)/i;
// The chat-completions payload shape is a reliable AI-call fingerprint even when
// the host/SDK are obfuscated (string-assembled, dynamic import, env var). The
// key/value separator is language-agnostic: JS object `model: 'gpt-…'`, JSON /
// Python-dict `"model": "gpt-…"`, Python kwargs / C# anon `model = "gpt-…"` —
// so the keys may be quoted and the separator may be `:` or `=`.
// Lazy gaps are BOUNDED ({0,2000}) so a `messages:[{role:…}]` with no nearby `content` key
// can't drive quadratic backtracking on a large file (the role→content distance in a real
// payload is tiny). Callers also gate this behind a cheap `/\bcontent\b/` pre-test.
const AI_PAYLOAD = /\bmessages\b["'`]?\s*[:=]\s*\[\s*\{[^]{0,2000}?\brole\b["'`]?\s*[:=]\s*['"`](system|user|assistant)['"`][^]{0,2000}?\bcontent\b/i;
const AI_MODEL = /\bmodel\b["'`]?\s*[:=]\s*['"`](gpt-|claude-|gemini|mistral|llama|text-embedding|text-davinci|chat-bison|o[134]-)/i;
// A network/import call that is NOT the approved same-origin /api proxy. Used to tell a
// genuine (host-obfuscated) direct AI call from a payload that merely rides the proxy.
const NON_PROXY_AI_CALL = /(\bfetch\s*\(|\baxios\b|XMLHttpRequest|new\s+WebSocket|\bimport\s*\()/i;
const PROXY_DEST = /['"`]\/api\//;
// A vendor AI host hidden via base64 (atob('…') / Buffer.from('…','base64')) — decode the
// literal and test the plaintext against VENDOR_HOST, so a string-obfuscated direct call to
// api.openai.com (etc.) can't evade §5.5 just because the host isn't spelled out in source.
const B64_LITERAL = /(?:atob|Buffer\.from)\s*\(\s*['"`]([A-Za-z0-9+/=]{8,})['"`]/g;
function decodeB64(s) {
  try { return typeof atob === 'function' ? atob(s) : (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64').toString('latin1') : ''); }
  catch { return ''; }
}
function hasObfuscatedVendorHost(clean) {
  B64_LITERAL.lastIndex = 0;
  let m;
  while ((m = B64_LITERAL.exec(clean)) !== null) {
    if (VENDOR_HOST.test(decodeB64(m[1]))) return true;
  }
  return false;
}
// A real client deliverable means an actual document-generation LIBRARY produced
// an artifact — not just a function NAMED generateReport / exportToPdf (reliance
// is un-inferable; a name must not auto-escalate to Approve).
// Note `(?<!\.)\bdocx\b` matches the `docx` LIBRARY but not a bare `report.docx` filename
// (which a VBA macro routinely writes without it being a relied-on client deliverable).
const STRONG_RELIANCE_EXPORT = /(jspdf|pdfkit|exceljs|xlsx\.(write|writeFile)|pptxgenjs|(?<!\.)\bdocx\b|html2pdf|html2canvas|puppeteer|officegen|carbone)/i;
// Sharing/reliance is mostly un-inferable from code; only fire on unambiguous
// markers. (Deliberately NOT `role:` — that collides with chat message roles.)
const STRONG_RELIANCE_SHARE = /(node-cron|cron\.schedule|@nestjs\/schedule|crontab|"bin"\s*:|#!\/usr\/bin\/env\s+node|\bargparse\b|click\.command|\bisAdmin\b|hasRole\s*\(|\b(colleagues|team\s*drive|other\s+users|multi[-\s]user|shared\s+with|for\s+the\s+team|the\s+(ap|ops|finance|accounting|sales)\s+team|everyone\s+(uses|on))\b)/i;
const PUBLIC_AUTH = /(allowanonymous\s*:\s*true|requireauth\s*:\s*false|auth\s*:\s*['"]none['"]|\bauth0\b|@clerk|firebase\/auth|supabase\.auth\.signup|createuserwithemailandpassword)/i;

function anyEvidenceMatches(entry, re) {
  return !!entry && entry.evidence.some((e) => re.test(e.text));
}

// Per-condition human copy. `pass`/`fail` are full sentences; `tag` is the
// right-aligned lane pill; refs tie back to the playbook.
const VERDICTS = {
  lane1: {
    key: 'lane1', lane: 'Lane 1 (light)', title: 'Lane 1',
    descriptor: 'The light path — a quick safety review, and you stay responsible',
    sentence: 'It can go live on the light path: published behind login after a quick safety review. You stay responsible for what it produces.',
    hosting: 'Shared hosting · login required · a quick review before it publishes · you stay responsible · 90-day check-in',
  },
  lane2: {
    key: 'lane2', lane: 'Lane 2', title: 'Lane 2',
    descriptor: 'Developer-built — Isolated Hosting',
    sentence: 'This POC needs developer work before it can be hosted. Not a failure — just a different path.',
    hosting: 'Isolated Hosting · dedicated resource · restricted Entra group',
  },
  approve: {
    key: 'approve', lane: 'Lane 2 (Approve-state)', title: 'Approve',
    descriptor: 'Approve-state → Lane 2 · AI Committee sign-off',
    sentence: 'This one goes to Lane 2 and needs AI Committee sign-off before it ships. Here is what triggered the review.',
    hosting: 'Isolated Hosting + Controlled Workflow Packet + AI Committee approval',
  },
};

// Free-text / fuzzy parsing markers that read as probabilistic (Yellow) even
// without a vendor model — "errors are silent" is the policy's exact concern.
const EXTRACTION_EXTRA = /(fuzzy|levenshtein|best[\s_-]?effort|heuristic|nearest\b|approximat|\bguess(es|ing|ed)?\b|confidence\s*[<>=:]|low\s*confidence|silently|parse(statement|invoice|bankstatement|receipt|document|resume|pdf|capital)|extract(_|\s)?(fields|line.?items|entities|text))/i;
// Output that is batched/exported/written without being shown to a human first
// — so there is no "100% human review of every output" (§5.4).
const SILENT_BATCH = /(download\s*\(|export(to)?csv|write[_]?csv|writefile(sync)?|to_csv|\.save\(|glob\s*\(|\.appendfile|for\s+\w+\s+in\s+glob)/i;
// A mutating call to an EXTERNAL host (vs the relative /api/chat proxy) is a
// real write/integration; a POST to a same-origin proxy is not.
const MUTATING_EXTERNAL = /(requests\.(post|put|patch|delete)\s*\(|axios\.(post|put|patch|delete)\s*\(\s*['"`]https?:\/\/|\.(post|put|patch|delete)\s*\(\s*['"`]https?:\/\/)/i;
// PUT / PATCH / DELETE is unambiguously a write to a record — even to a relative
// path — because the approved AI proxy only ever uses POST. This catches the
// "it updated a system" case the 6/25 meeting named as the real Lane-2 gate.
const METHOD_WRITE = /method\s*:\s*['"`](put|patch|delete)['"`]/i;
// Real source-of-truth WRITES: SQL/ORM mutation or BaaS evidence. Deliberately does
// NOT match a bare `.create(`/`.save(` — those collide with AI SDKs (messages.create)
// and generic builders — and (since the QA pass) NO LONGER matches a bare driver-name
// IMPORT: importing `pg`/`mongoose`/`sqlalchemy` and only reading from it is not a write,
// so it must not auto-escalate to Approve. A bare driver import is instead a Lane-2 "live
// data connection" hint (DB_DRIVER_IMPORT, below). Only an actual mutation lands here.
const DB_ORM_WRITE = /(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert|merge\s+into|create\s+table|alter\s+table|prisma\.[a-z]+\.(create|update|upsert|delete)|\.(insertone|insertmany|updateone|updatemany|deleteone|deletemany|bulkcreate|findoneandupdate)\s*\(|createpool\s*\(|createconnection\s*\(|database_url|(postgres|postgresql|mysql|mongodb):\/\/)/i;
// A database driver/ORM that is merely IMPORTED/connected (no mutation) is a live external
// data connection per §6 -> Lane 2, NOT an authoritative write (-> Approve). The `(?!:)`
// keeps a `scheme:` DSN position (PDO's "mysql:host=…") from reading as an import.
const DB_DRIVER_IMPORT = /\b(pg|mysql2?|sqlite3|better-sqlite3|mongodb|mongoose|psycopg2?|sqlalchemy|knex|sequelize|typeorm|cx_oracle|@prisma\/client)\b(?!:)(?!\.Databases?\s*\()/i;
// A genuine backend runtime — framework, listener, serverless dir, or container —
// not merely a client file that happens to be named app.js / main.js / server.js.
const BACKEND_STRONG = /(import\s+express|require\(['"]express['"]\)|"express"\s*:|\bfastify\b|@nestjs\/|\bkoa\b|from\s+flask\s+import|flask\(__name__\)|from\s+fastapi\s+import|fastapi\s*\(|app\.listen\s*\(|http\.createserver|createserver\s*\(|app\.(get|post|put|delete)\s*\()/i;
// Server runtimes the JS/Python-tuned list above misses, so a benign-but-standalone
// server (Go/C#/Java/PHP/other-Python) is still §6 Lane 2 even with deterministic
// logic. A live server process can't run on the static shared host.
const BACKEND_OTHER = /(http\.ListenAndServe|http\.NewServeMux|gin\.(Default|New)\s*\(|echo\.New\s*\(|fiber\.New\s*\(|chi\.NewRouter\s*\(|mux\.NewRouter\s*\(|\.Run\s*\(\s*['"`]:\d|WebApplication\.CreateBuilder|app\.Map(Get|Post|Put|Delete|Patch|Group|Methods|Controllers)|\bapp\.Run\s*\(|:\s*ControllerBase\b|\[ApiController\]|@RestController|@SpringBootApplication|@(Get|Post|Put|Delete|Patch|Request)Mapping|SpringApplication\.run|uvicorn\.run|\bgunicorn\b|from\s+django\b|\baiohttp\b|\btornado\b|\bsanic\b|\bstarlette\b|<\?php)/i;
const BACKEND_PATH = /(pages\/api\/|app\/api\/.*\/route\.(js|ts)|netlify\/functions\/|(^|\/)functions\/.*\.(js|ts)$|(^|\/)dockerfile$|docker-compose|(^|\/)procfile$|\.php$)/i;
// ORM / driver writes the SQL-and-JS-ORM-tuned DB_ORM_WRITE misses: EF Core
// (.SaveChanges), R DBI (dbWriteTable/dbExecute), pandas (.to_sql), JPA/JDBC.
// Each token is framework-specific, so it can't collide with a generic call.
const EXTRA_ORM_WRITE = /(\.SaveChanges(Async)?\s*\(|\bdbWriteTable\s*\(|\bdbAppendTable\s*\(|\bdbExecute\s*\(|\bdbSendStatement\s*\(|\.to_sql\s*\(|entityManager\.(persist|merge)\s*\(|\.executeUpdate\s*\(|jdbcTemplate\.(update|batchUpdate)\s*\()/i;
// Mutating SQL run as a stored procedure (the ADODB/connection idiom INSERT/UPDATE miss).
const STORED_PROC_EXEC = /\bexec(ute)?\s+(\[?dbo\]?\.)?\[?(sp_|usp_|p_)[a-z0-9_]+/i;

// ---- Spreadsheet (VBA / Power Query / formula / connection) detectors -------------------
// A workbook that shells out, imports Win32, touches the registry, or does FSO file
// management can't live on the static shared host (§6). Deliberately NOT the bare
// Scripting.FileSystemObject object (read-only existence checks stay Lane 1) and NOT
// Application.Run (in-workbook macro dispatch, not OS execution).
// Also covers WMI process execution (GetObject "winmgmts:" / Win32_Process.Create) — a
// common way to launch a process without the Shell/WScript.Shell tokens.
const VBA_OS_INTEGRATION = /\bShell\s*\(|(^|:)\s*Shell\s+["']|\bShell\s+["'][^"'\n]*\.(exe|cmd|bat|ps1|vbs|scr|com)\b|CreateObject\s*\(\s*["'](WScript\.Shell|WshShell|Shell\.Application)["']|\bDeclare\s+(PtrSafe\s+)?(Function|Sub)\s+\w+\s+Lib\s+["']|\b(URLDownloadToFile[AW]?|InternetOpenUrl[AW]?|WinExec|ShellExecute[AW]?|CreateProcess[AW]?)\b|\.(RegWrite|RegDelete)\b|\.(CopyFile|MoveFile|DeleteFile|CopyFolder|DeleteFolder)\s*[("']|=\s*cmd\s*\||\bDDEInitiate\s*\(|GetObject\s*\(\s*["']winmgmts:|CreateObject\s*\(\s*["']WbemScripting\.SWbemLocator["']|\bWin32_Process\b/i;
// A live external data source — DB / ODBC / OLEDB / OData / Power Query / workbook
// connection. §6 "live data connection / integration" -> Lane 2 WITHOUT claiming a server
// runtime. The connection is read-or-write; an INSERT/UPDATE through it independently sets
// dbWrite (-> Approve), so a read-only feed lands at Lane 2 and a writing one at Approve.
//   CODE clauses are structural (a `Provider.Database(` M call, an ADODB object, a <dbPr>
//   element) and safe to grep over EVERY artifact. `\w+\.Databases?\(` covers every Power
//   Query DB connector generically (Sql/PostgreSQL/MySQL/Db2/Teradata/SapHana/Oracle/…),
//   not a closed allowlist.
const LIVE_DATA_CONN_CODE = /\b[A-Za-z][\w.]*\.Databases?\s*\(|Odbc\.(DataSource|Query)\s*\(|OleDb\.DataSource\s*\(|\bSnowflake\.\w+\s*\(|CreateObject\s*\(\s*["']ADODB\.(Connection|Recordset|Command)["']|New\s+ADODB\.(Connection|Recordset|Command)|<(dbPr|olapPr|webPr)\b/i;
//   STRING clauses are loose connection-string fragments that can appear in benign prose
//   (a defined-name label, a cell formula), so they are grepped ONLY over artifacts that
//   actually carry connection strings (connections.xml, VBA, Power Query) — never over
//   names/.defnames, formulas/.formulas, or links/.xllinks.
const LIVE_DATA_CONN_STRING = /Provider\s*=\s*(SQLOLEDB|MSDASQL|Microsoft\.ACE\.OLEDB|MSDAORA)|\bDSN\s*=\s*\w|Initial\s*Catalog\s*=|Data\s*Source\s*=\s*[A-Za-z\\]|connectionId\s*=/i;
// VBA writes a file to disk -> local persistence (fails §5.7 only when data is sensitive).
const VBA_FILE_WRITE = /\bOpen\s+[^\n]*\bFor\s+(Output|Append|Binary)\b|\b(Print|Write)\s+#|\.CreateTextFile\s*\(/i;
// VBA saves/copies to a UNC network share OR a mapped network drive (any drive letter but
// C:) -> others consume it (Register tier; user-overridable via the reliance assumption).
// Local C:\ scratch saves stay Lane 1.
const VBA_SHARE_WRITE = /(SaveAs|SaveCopyAs|FileCopy)\b[^\n]*["']\\\\[\w.$-]+\\|["']\\\\[\w.$-]+\\[^"'\n]+\.(xls[xmb]?|csv|txt|pdf|xml|json)["']|(SaveAs|SaveCopyAs|FileCopy)\b[^\n]*["'](?![Cc]:)[A-Za-z]:\\/i;
// Spreadsheet outbound web idioms — VBA HTTP objects, no-paren .Open to an external URL,
// Power Query Web.Contents/OData/SharePoint, =WEBSERVICE to a non-gpfs URL, Win32 net APIs.
// Scoped via grepSheet so a normal code POC that happens to contain these words is unaffected.
const SHEET_OUTBOUND = /(MSXML2\.(XMLHTTP|ServerXMLHTTP)|WinHttp\.WinHttpRequest|Microsoft\.XMLHTTP)|\.Open\s+["']?(GET|POST|PUT|PATCH|DELETE)["']?\s*,\s*["'`]https?:\/\/(?!([a-z0-9.-]*\.)?gpfundsolutions\.com)|(Web\.Contents|OData\.Feed|SharePoint\.(Files|Contents|Tables))\s*\(|WEBSERVICE\s*\(\s*["']https?:\/\/(?!([a-z0-9.-]*\.)?gpfundsolutions\.com)|\b(URLDownloadToFile[AW]?|InternetOpenUrl[AW]?|WinHttpOpen)\b/i;

// Pure resolver: from the code-derived facts + user assumptions, produce the
// verdict and which §5 conditions hold. Pulled out of analyze() so we can answer
// "what if I made this one change?" by calling it again with one fact flipped.
function decide(f, ua = {}) {
  const autoDataScope = f.restrictedStrong ? 'restricted' : 'general';
  const autoReliance = (f.relianceExport || (f.drafting && f.restrictedStrong)) ? 'deliverable' : f.relianceShare ? 'shared' : 'personal';
  const autoWriteAuthority = f.dbWrite ? 'authoritative' : 'none';
  const dataScope = ua.dataScope || autoDataScope;
  const reliance = ua.reliance || autoReliance;
  const writeAuthority = ua.writeAuthority || autoWriteAuthority;
  const humanReview = ua.humanReview;
  const reliedProbabilistic = f.probabilistic && (humanReview === false || (humanReview === undefined && f.silentBatch));
  const authoritativeWrite = f.dbWrite && writeAuthority === 'authoritative';
  const approve = authoritativeWrite || reliance === 'deliverable' || (dataScope === 'restricted' && reliedProbabilistic);
  const register = !approve && reliance === 'shared';
  const tier = approve ? 'Approve' : register ? 'Register' : 'Use';
  const posture = f.probabilistic ? 'Yellow' : 'Green';
  const yellowOk = posture === 'Green' ? true : humanReview === true ? true : humanReview === false ? false : (tier === 'Use' && !f.silentBatch);
  const pass = {
    host: !f.backend && !f.liveDataConnection,
    c51: tier === 'Use',
    c52: dataScope === 'general' || !(authoritativeWrite || reliedProbabilistic || reliance === 'deliverable'),
    c53: !authoritativeWrite,
    c54: yellowOk,
    c55: !f.directAI,
    c56: !(f.cdnScript || f.outbound || f.publicAuth),
    c57: !(f.persistence && dataScope === 'restricted'),
  };
  const lane1Hold = ['c52', 'c53', 'c54', 'c55', 'c56', 'c57'].every((k) => pass[k]) && pass.host;
  let verdictKey;
  if (tier === 'Approve') verdictKey = 'approve';
  else if (tier === 'Register') verdictKey = 'lane2';
  else if (!pass.host) verdictKey = 'lane2';
  else verdictKey = lane1Hold ? 'lane1' : 'lane2';
  return { verdictKey, tier, posture, dataScope, reliance, writeAuthority, humanReview, reliedProbabilistic, authoritativeWrite, pass, autoDataScope, autoReliance, autoWriteAuthority };
}

// Derive every fact that depends ONLY on the code — never on user assumptions. This is
// the expensive half (scan + greps + detectors); the UI caches it per corpus so what-if
// toggles re-run only the cheap resolve() below instead of re-scanning every file.
// evOf builds up-to-3 deduped evidence rows for the §5 display from the scan's signal
// map (S). Factored out of extractFacts so the same closure can be re-attached AFTER the
// heavy scan runs in a Web Worker — functions don't survive structured-clone, so the
// worker returns the serializable core (which carries S as plain data) and the main
// thread calls hydrateFacts() to rebuild this. See extractFactsCore / hydrateFacts.
function makeEvOf(S) {
  return (...ids) => {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const e = S[id];
      if (!e) continue;
      const list = e.runtimeEvidence.length ? e.runtimeEvidence : e.evidence;
      for (const it of list) {
        const k = it.path + ':' + it.line + ':' + it.text;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ path: it.path, line: it.line, text: it.text });
        if (out.length >= 3) return out;
      }
    }
    return out;
  };
}

// extractFactsCore: the heavy scan + fact derivation. Returns ONLY serializable data
// (no evOf closure, so it survives a Worker postMessage). Call hydrateFacts() on the
// result to get a bundle resolve() can use. extractFacts() below composes the two for
// callers that run everything on one thread (tests, advisor, the sync fallback).
export function extractFactsCore(corpus) {
  const scan = scanCorpus(corpus);
  const S = scan.signals;
  // Reuse the comment-stripped text the scanner already produced — no second strip pass.
  // Carry each file's role so detectors can be runtime-scoped (an AI payload / app.get() /
  // INSERT in a README or *.test.js must not set a runtime fact). See cleanFilesCode below.
  const cleanFiles = scan.files.map((p) => ({ path: p.path, role: p.role, clean: p.stripped }));
  const grep = (re) => cleanFiles.some((f) => re.test(f.clean));
  // grep ONLY the synthetic spreadsheet artifacts (VBA / formulas / connections / queries).
  // The VBA/PQ/connection detectors run through this so they can NEVER affect the existing
  // code corpus or collide with JS/Python/C idioms (fs.copyFile, exec(, CreateProcess…).
  // The extractor ALWAYS emits artifacts under the directory prefixes below, so those match
  // unconditionally. The bare-extension half is gated to a real spreadsheet upload — without
  // the gate, .m / .cls / .bas would mis-claim MATLAB / Apex / FreeBASIC files in a code repo.
  const sheetSrc = !!(corpus && corpus.source === 'spreadsheet');
  const isSheetArtifact = (p) => /(^|\/)(vba|formulas|powerquery|connections|names|links|macrosheets)\//i.test(p) || (sheetSrc && /\.(vba|bas|cls|frm|m|pq|formulas|defnames|xllinks|xlm)$/i.test(p));
  const grepSheet = (re) => cleanFiles.some((f) => isSheetArtifact(f.path) && re.test(f.clean));
  // Connection strings only legitimately live in VBA, Power Query, or connections.xml — NOT
  // in extracted defined names / cell formulas / link lists, where the same fragment
  // ("Data Source=", "DSN=") could be benign label prose. Scope loose conn-string greps here.
  const isConnArtifact = (p) => /(^|\/)(vba|powerquery|connections)\//i.test(p) || (sheetSrc && /\.(vba|bas|cls|frm|m|pq)$/i.test(p));
  const grepConn = (re) => cleanFiles.some((f) => isConnArtifact(f.path) && re.test(f.clean));
  const fired = (id) => !!(S[id] && S[id].firedRuntime);
  const entry = (id) => S[id];

  // A file named *.spec.js / *.test.js is treated as a test (its AI calls don't
  // count) — UNLESS runtime code actually imports it, in which case it ships.
  const importedNames = new Set();
  for (const p of scan.files) {
    if (p.role === 'test') continue;
    for (const m of p.stripped.matchAll(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g)) {
      importedNames.add(m[1].split('/').pop().replace(/\.(m?[jt]sx?)$/, ''));
    }
  }
  const isImportedTest = (p) => importedNames.has(p.split('/').pop().replace(/\.(m?[jt]sx?)$/, ''));
  const firesAt = (id, pred) => !!(entry(id) && entry(id).evidence.some(pred));

  // ---- Code-certain technical facts ---------------------------------------
  // A vendor host counts only from code that ships (runtimeEvidence) — a README documenting
  // "this calls api.openai.com" must not set a direct-AI fact; judge the code, not the prose.
  const dvhEntry = entry('runtime-ai-direct-vendor-host');
  const directHost = !!(dvhEntry && dvhEntry.runtimeEvidence.some((e) => VENDOR_HOST.test(e.text)));
  // An AI SDK counts as a runtime call only when actually imported in source —
  // a bare listing in package.json (even outside devDependencies) doesn't —
  // but a "spec/test" module that runtime code imports does ship.
  const sdkEntry = entry('runtime-ai-vendor-sdk-import');
  const sdkImport = !!(sdkEntry && sdkEntry.evidence.some((e) => (e.runtime && e.role !== 'manifest') || (e.role === 'test' && isImportedTest(e.path))));
  const clientKey = fired('client-side-model-api-key') || firesAt('client-side-model-api-key', (e) => e.role === 'test' && isImportedTest(e.path));
  // An LLM payload (model + chat messages) that is NOT going to the approved
  // same-origin proxy is a direct AI call, however the host/SDK were hidden.
  const proxyPresent = !!(entry('approved-enterprise-proxy') && entry('approved-enterprise-proxy').fired);
  // Only judge AI/write/network facts in code that actually ships: a payload, INSERT, or vendor
  // host in a README or in a *.test.js (that runtime code never imports) is not a runtime fact.
  // Keep the imported-test escape (a "spec" module that runtime code actually imports ships).
  const cleanFilesCode = cleanFiles.filter((f) => f.role !== 'doc' && (f.role !== 'test' || isImportedTest(f.path)));
  const grepCode = (re) => cleanFilesCode.some((f) => re.test(f.clean));
  // An LLM chat payload (model + messages) anywhere in shipping code. The `content` pre-test
  // keeps the bounded AI_PAYLOAD off any file that can't match it (and off the ReDoS path).
  const anyPayload = cleanFilesCode.some((f) => AI_MODEL.test(f.clean) || (/\bcontent\b/.test(f.clean) && AI_PAYLOAD.test(f.clean)));
  // Direct AI destination, two ways:
  //  (a) per-file: a payload co-located with its own non-/api network/import call (the original).
  //  (b) cross-file: the three ingredients of a direct call present ANYWHERE in shipping code —
  //      a payload, a non-/api network/import call, AND a vendor host SPELLED OUT or base64-
  //      obfuscated — even when split across files with a benign /api/chat proxy elsewhere.
  //  (b) closes the §5.5 evasion the per-file-only test missed. The vendor-host requirement keeps
  //  it from over-firing on ordinary code-splitting import()/relative fetch (those carry no host).
  const perFileDirect = cleanFilesCode.some((f) =>
    (AI_MODEL.test(f.clean) || (/\bcontent\b/.test(f.clean) && AI_PAYLOAD.test(f.clean)))
    && NON_PROXY_AI_CALL.test(f.clean) && !PROXY_DEST.test(f.clean));
  // A SPELLED-OUT vendor host in shipping code already sets directHost (-> directAI) on its own,
  // so the cross-file path only needs to add the OBFUSCATED (base64) case: a payload + a non-/api
  // call + a base64-decoded vendor host, anywhere in shipping code.
  const anyNonProxyCall = cleanFilesCode.some((f) => NON_PROXY_AI_CALL.test(f.clean) && !PROXY_DEST.test(f.clean));
  const crossFileVendor = anyPayload && anyNonProxyCall && cleanFilesCode.some((f) => hasObfuscatedVendorHost(f.clean));
  const directAiDest = perFileDirect || crossFileVendor;
  const aiPayload = anyPayload && (!proxyPresent || directAiDest);
  const directAI = directHost || sdkImport || clientKey || aiPayload;
  const proxyAI = proxyPresent && !directAI;
  const localML = fired('logic-probabilistic-ml-inference');
  const backendEv = entry('backend-server-present')?.runtimeEvidence || [];
  // Excel-4.0 (XLM) macro-sheet OS/DLL execution — EXEC/CALL/REGISTER/FOPEN. Path-scoped to
  // .xlm so it can't collide with Python exec(/C fopen(/JS .call( in the code corpus.
  const excel4Exec = cleanFiles.some((f) => /\.xlm$/i.test(f.path) && /\b(EXEC|CALL|REGISTER|FOPEN|FWRITE|FWRITELN)\s*\(/i.test(f.clean));
  // Macros present but unreadable (password-protected / stomped / corrupt): can't be cleared
  // by reading, so default cautiously to Lane 2 (the extractor emits this sentinel).
  const vbaUnreadable = grepSheet(/VBA_PROJECT_PRESENT_UNREADABLE/);
  const backend = backendEv.some((e) => BACKEND_STRONG.test(e.text)) || backendEv.some((e) => BACKEND_PATH.test(e.path))
    || grep(BACKEND_OTHER) || grepSheet(VBA_OS_INTEGRATION) || excel4Exec || vbaUnreadable || cleanFiles.some((f) => /\.php$/i.test(f.path));
  // A write to a system of record: DB/ORM/SQL or BaaS, a mutating call to an
  // external host, a same-origin POST to a write-y path, an ORM-chain write, a Go
  // (gorm/http) write, or a save to a network share — NOT a POST to /api/chat.
  // grep the precise write regex over the full comment-stripped corpus, NOT the signal's
  // 6-slot-capped evidence — broad benign matches (.save()/.create()) in earlier files
  // could otherwise crowd out a genuine INSERT/prisma write in a later file (false Lane 1).
  // All write detectors are role-scoped (grepCode / cleanFilesCode): an INSERT/UPDATE/PUT in a
  // README or a non-imported *.test.js demonstrates, but does not ship, a write.
  const dbOrmWrite = grepCode(DB_ORM_WRITE);
  const dbWrite = dbOrmWrite || fired('backend-as-a-service-write')
    || grepCode(MUTATING_EXTERNAL)
    || cleanFilesCode.some((f) => METHOD_WRITE.test(f.clean))      // PUT/PATCH/DELETE = an unambiguous record write
    || cleanFilesCode.some((f) => hasFetchPostWrite(f.clean))      // external/relative POST to a write-y path (linear — replaces the ReDoS regexes)
    || grepCode(XHR_MUTATE_EXTERNAL) || grepCode(SHARED_PATH_WRITE)
    || grepCode(ORM_CHAIN_WRITE) || grepCode(GO_WRITE) || grepCode(EXTRA_ORM_WRITE) || grepSheet(STORED_PROC_EXEC);
  const cdnScript = fired('third-party-cdn-script') || fired('third-party-analytics-telemetry');
  // outbound = the global ruleset signal (fetch/axios/XHR/WebSocket to external hosts) PLUS
  // spreadsheet-scoped web idioms (VBA XMLHTTP/WinHTTP, PQ Web.Contents/SharePoint, =WEBSERVICE,
  // URLDownloadToFile) and VBA email automation (Outlook/CDO). All spreadsheet patterns run
  // through grepSheet so they CANNOT escalate a normal code POC that merely uses those words.
  const outbound = fired('outbound-network-call-nonallowlisted')
    || grepSheet(SHEET_OUTBOUND)
    || grepSheet(/CreateObject\s*\(\s*["'](Outlook\.Application|CDO\.Message|Redemption\.\w+)["']|\.CreateItem\s*\(\s*(0|olMailItem)\b/i);
  // A live external data feed (DB/ODBC/OLEDB/Power-Query/workbook connection) is the §6
  // "live data connection / integration" Lane-2 trigger — distinct from a server runtime.
  const liveDataConnection = grepSheet(LIVE_DATA_CONN_CODE) || grepConn(LIVE_DATA_CONN_STRING)
    || cleanFilesCode.some((f) => DB_DRIVER_IMPORT.test(f.clean));  // a DB driver imported but not mutating = §6 connection
  const persistence = fired('client-persistence-sensitive') || grepSheet(VBA_FILE_WRITE);
  // grep over full corpus, not capped evidence — benign SSO mentions (msal/oidc/saml)
  // must not crowd out an explicit allowAnonymous/public-auth flag in a later file.
  const publicAuth = grep(PUBLIC_AUTH);

  // ---- Logic posture (STAR §3.2) ------------------------------------------
  const extraction = fired('logic-probabilistic-extraction-parsing') || grep(EXTRACTION_EXTRA);
  const qa = fired('logic-probabilistic-qa-retrieval');
  // "Drafting" is only probabilistic (Yellow) when an actual model produces it —
  // a deterministic function merely NAMED generateReport is Green.
  const drafting = fired('logic-probabilistic-summarize-draft') && (directAI || proxyAI || localML);
  const deterministic = fired('logic-deterministic-green');
  const probabilistic = directAI || proxyAI || localML || extraction || qa || drafting;
  // Is probabilistic output exported/written in a batch (no human sees each
  // result), rather than shown interactively for review? (posture itself comes
  // from the resolver below.)
  const silentBatch = probabilistic && grep(SILENT_BATCH);

  // ---- Dimensions code cannot prove -> auto-defaults, user-overridable -----
  const restrictedStrong = detectRestricted(cleanFiles);
  // grep over full corpus, not capped evidence — benign generate*Report NAMES must not
  // crowd out a genuine doc-gen library import (jspdf/exceljs…) that escalates to Approve.
  const relianceExport = grep(STRONG_RELIANCE_EXPORT);
  const relianceShare = grep(STRONG_RELIANCE_SHARE) || grepSheet(VBA_SHARE_WRITE);

  // Bundle the code-derived facts and let the pure resolver do STEP 1 + STEP 2.
  const facts = {
    directAI, proxyAI, localML, backend, liveDataConnection, dbWrite, cdnScript, outbound, persistence, publicAuth,
    extraction, qa, drafting, deterministic, probabilistic, silentBatch,
    restrictedStrong, relianceExport, relianceShare,
  };

  // ---- Pattern classification (informational "Looks like…") — code-only -----
  let pattern = 'Utility';
  if (qa) pattern = 'Document Q&A / retrieval';
  else if (extraction) pattern = 'Extraction / parsing';
  else if (drafting || directAI || proxyAI) pattern = 'Drafting / summarizing';
  else if (localML) pattern = 'ML scoring / inference';
  else if (dbWrite || backend || liveDataConnection) pattern = 'Data entry / integration';
  else if (anyEvidenceMatches(entry('logic-deterministic-green'), /intl\.numberformat|tolocalestring|tofixed|date-fns|dayjs|\bformat\b/i) || fired('numeric-mutation-downstream')) pattern = 'Data formatting';
  else if (anyEvidenceMatches(entry('logic-deterministic-green'), /\bvalidate\w*\b|\bzod\b|\byup\b|\bjoi\b|\.test\(/i)) pattern = 'Data validation';
  else if (deterministic) pattern = 'Data entry / formatting';

  const buildTool = entry('build-tool-ai-attribution') && entry('build-tool-ai-attribution').fired
    ? (entry('build-tool-ai-attribution').evidence[0]?.text || 'AI-assisted build') : null;

  // ---- Confidence base: how well could the engine see the code? The single-
  // snippet adjustment depends on the verdict, so it is applied later in resolve().
  const runtimeFiles = scan.files.filter((p) => p.role === 'runtime');
  const minifiedRuntime = runtimeFiles.filter((p) => isMinified(p.text || ''));
  const sawSource = runtimeFiles.some((p) => !isMinified(p.text || ''));
  const confReasons = [];
  let confLevel = 'high';
  if (runtimeFiles.length && !sawSource) {
    confLevel = 'low';
    confReasons.push('Only minified/built code was available — not the original source, so some calls may be hidden.');
  } else if (!runtimeFiles.length) {
    confLevel = 'low';
    confReasons.push('No source files were read — this is based on docs and config only.');
  } else if (minifiedRuntime.length) {
    confLevel = 'medium';
    confReasons.push('Some files are minified, so a few signals could be hidden.');
  }

  return {
    facts, signals: S, pattern, buildTool,
    confBase: { level: confLevel, reasons: confReasons },
    fileCount: scan.fileCount,
    meta: {
      label: (corpus && corpus.label) || 'POC',
      source: (corpus && corpus.source) || 'upload',
      repoMeta: (corpus && corpus.meta) || {},
      notes: (corpus && corpus.notes) || [],
    },
  };
}

// Re-attach the evOf closure (lost across a Worker structured-clone) to a serializable
// core, producing the bundle resolve() consumes. `signals` carries the scan's evidence
// map as plain data, so makeEvOf can rebuild the exact same lookup off-thread.
export function hydrateFacts(core) {
  return { ...core, evOf: makeEvOf(core.signals) };
}

// Public entry: scan + derive + hydrate on the calling thread. The Worker path calls
// extractFactsCore() in the worker and hydrateFacts() on the main thread instead, so the
// scan never blocks the UI. resolve(extractFacts(corpus)) behaves exactly as before.
export function extractFacts(corpus) {
  return hydrateFacts(extractFactsCore(corpus));
}

// Pure resolver: cached facts + user assumptions -> verdict, §5 rows, demotion hints,
// certainty and confidence. Cheap and re-runnable on every what-if toggle (no re-scan).
export function resolve(bundle, assumptions = {}) {
  const { facts, evOf } = bundle;
  const { directAI, proxyAI, localML, backend, liveDataConnection, dbWrite, cdnScript, outbound, persistence, publicAuth, probabilistic, silentBatch } = facts;
  const D = decide(facts, assumptions);
  const { tier, posture, dataScope, reliance, writeAuthority, humanReview, authoritativeWrite, reliedProbabilistic, pass } = D;
  const verdictKey = D.verdictKey;

  const used = {
    dataScope, reliance, writeAuthority,
    auto: { dataScope: D.autoDataScope, reliance: D.autoReliance, writeAuthority: D.autoWriteAuthority },
    overridden: {
      dataScope: !!assumptions.dataScope, reliance: !!assumptions.reliance,
      writeAuthority: !!assumptions.writeAuthority, humanReview: assumptions.humanReview !== undefined,
    },
  };

  const c = {
    host: {
      id: 'host', ref: '§6',
      title: backend ? 'Custom server runtime' : liveDataConnection ? 'Live external data connection' : 'Self-contained front-end',
      pass: pass.host,
      sentence: backend
        ? 'Does work a plain static page can’t host — its own server runtime, or direct system/OS access — so it needs an isolated environment.'
        : liveDataConnection
          ? 'Connects to a live external data source (database, ODBC/OLEDB, or a query feed), so it isn’t a self-contained static file — §6 routes it to Lane 2.'
          : 'Builds to plain files that any shared host can serve — nothing to run on the server.',
      ev: backend ? evOf('backend-server-present', 'vba-os-integration', 'excel4-macro-exec', 'vba-present-unreadable')
        : liveDataConnection ? evOf('vba-live-data-connection', 'pq-live-data-connection', 'connections-external-data') : [],
    },
    c51: {
      id: 'c51', ref: '§5.1', title: 'Risk tier',
      pass: pass.c51,
      sentence: tier === 'Use'
        ? 'Personal use on general data, reviewed by you — the Use tier, which Lane 1 allows.'
        : tier === 'Register'
          ? 'Shared or relied on by others, so it registers above personal use — Lane 1 needs the Use tier.'
          : 'Lands in Approve-state, so it goes to Lane 2 regardless of anything else — the tier always wins.',
      ev: [],
      assumption: { kind: 'reliance', value: reliance, auto: D.autoReliance,
        options: [
          { value: 'personal', label: 'Just me' },
          { value: 'shared', label: 'Shared with others' },
          { value: 'deliverable', label: 'Feeds a deliverable / control' },
        ] },
    },
    c52: {
      id: 'c52', ref: '§5.2', title: 'Data it works with',
      pass: pass.c52,
      sentence: dataScope === 'general'
        ? 'Works with general data only.'
        : (authoritativeWrite || reliedProbabilistic || reliance === 'deliverable')
          ? 'Works with client/fund data and also updates a record, feeds a deliverable, or isn’t reviewed — that combination needs a sign-off.'
          : 'Works with client/fund data — fine for the light path, since it only reads or formats it and you review the result.',
      ev: dataScope === 'restricted' ? evOf('data-scope-restricted-keywords') : [],
      assumption: { kind: 'dataScope', value: dataScope, auto: D.autoDataScope,
        options: [
          { value: 'general', label: 'General data only' },
          { value: 'restricted', label: 'Client / Fund / Restricted' },
        ] },
    },
    c53: {
      id: 'c53', ref: '§5.3', title: 'Writes to systems of record',
      pass: pass.c53,
      sentence: !dbWrite
        ? 'No writes to a database or system of record — it only reads or formats.'
        : authoritativeWrite
          ? 'Writes to what looks like a system of record, which Lane 1 forbids.'
          : 'Writes only to a scratch/demo store you’ve marked as non-authoritative.',
      ev: dbWrite ? evOf('db-source-of-truth-write', 'backend-as-a-service-write') : [],
      assumption: dbWrite ? { kind: 'writeAuthority', value: writeAuthority, auto: D.autoWriteAuthority,
        options: [
          { value: 'authoritative', label: 'System of record' },
          { value: 'scratch', label: 'Scratch / demo store' },
        ] } : null,
    },
    c54: {
      id: 'c54', ref: '§5.4', title: 'Logic posture',
      pass: pass.c54,
      sentence: posture === 'Green'
        ? 'Deterministic, rule-based logic — the green posture Lane 1 prefers.'
        : pass.c54
          ? 'Probabilistic (yellow) logic, but acceptable because every output is reviewed before use.'
          : 'Probabilistic (yellow) logic that others rely on without a guaranteed human-review step.',
      ev: probabilistic ? evOf('logic-probabilistic-extraction-parsing', 'logic-probabilistic-qa-retrieval', 'logic-probabilistic-summarize-draft', 'logic-probabilistic-ml-inference') : [],
      assumption: posture === 'Yellow' ? { kind: 'humanReview', value: humanReview === false || (humanReview === undefined && silentBatch) ? 'no' : 'yes', auto: silentBatch ? 'no' : 'yes',
        options: [
          { value: 'yes', label: 'Every output reviewed' },
          { value: 'no', label: 'Not always reviewed' },
        ] } : null,
    },
    c55: {
      id: 'c55', ref: '§5.5', title: 'Runtime AI calls',
      pass: pass.c55,
      sentence: directAI
        ? 'Calls an external AI model directly (vendor API, SDK, or client-side key) — Lane 1 allows only the approved enterprise proxy.'
        : proxyAI
          ? 'Uses the approved enterprise /api/chat proxy — the one AI-call shape Lane 1 permits.'
          : localML
            ? 'Runs a local model in the browser — no external AI network call (but its output is probabilistic, see logic).'
            : 'Makes no runtime AI model calls.',
      ev: directAI ? evOf('runtime-ai-direct-vendor-host', 'runtime-ai-vendor-sdk-import', 'client-side-model-api-key')
        : proxyAI ? evOf('approved-enterprise-proxy') : [],
    },
    c56: {
      id: 'c56', ref: '§5.6', title: 'Outbound calls & third-party scripts',
      pass: pass.c56,
      sentence: cdnScript
        ? 'Loads third-party scripts from an external CDN, which Lane 1’s SSO-fronted page does not allow.'
        : outbound
          ? 'Makes outbound calls to non-allowlisted external hosts — confirm each host is on the approved allowlist.'
          : publicAuth
            ? 'Configures public/consumer auth that bypasses single sign-on (SSO).'
            : 'No third-party scripts and no outbound calls beyond same-origin — runs cleanly behind SSO.',
      ev: cdnScript ? evOf('third-party-cdn-script', 'third-party-analytics-telemetry')
        : outbound ? evOf('outbound-network-call-nonallowlisted', 'spreadsheet-web-outbound', 'formula-web-call', 'vba-outlook-email') : [],
    },
    c57: {
      id: 'c57', ref: '§5.7', title: 'Local data persistence',
      pass: pass.c57,
      sentence: !persistence
        ? 'Persists nothing in the browser.'
        : dataScope === 'restricted'
          ? 'Persists data locally while handling sensitive information — Lane 1 forbids storing Client/Fund or Restricted data.'
          : 'Persists only general data locally, which Lane 1 permits.',
      ev: persistence ? evOf('client-persistence-sensitive') : [],
    },
  };

  // verdictKey already resolved by decide() above.

  // ---- Per-condition status, tag, driving --------------------------------
  // A failed condition that contributes to Approve reads as "Review" (purple);
  // other failures read as "Lane 2" (amber). Passing reads as "Lane 1" (green).
  const approveTriggers = new Set();
  if (authoritativeWrite) approveTriggers.add('c53');
  if (reliance === 'deliverable') approveTriggers.add('c51');
  if (dataScope === 'restricted' && reliedProbabilistic) { approveTriggers.add('c54'); approveTriggers.add('c52'); }
  if (tier === 'Approve') approveTriggers.add('c51');

  const order = ['host', 'c51', 'c52', 'c53', 'c54', 'c55', 'c56', 'c57'];
  const conditions = order.map((k) => {
    const cc = c[k];
    let status, laneTag;
    if (cc.pass) { status = 'pass'; laneTag = 'Lane 1'; }
    else if (approveTriggers.has(k) || (k === 'c51' && tier === 'Approve')) { status = 'review'; laneTag = 'Review'; }
    else { status = 'lane2'; laneTag = 'Lane 2'; }
    return {
      id: cc.id, ref: cc.ref, title: cc.title, sentence: cc.sentence,
      status, laneTag, evidence: cc.ev || [], assumption: cc.assumption || null,
      driving: false,
    };
  });

  // Driving conditions = what actually decided a non-Lane-1 outcome.
  const byId = Object.fromEntries(conditions.map((x) => [x.id, x]));
  if (verdictKey !== 'lane1') {
    const drivers = [];
    if (verdictKey === 'approve') {
      if (authoritativeWrite) drivers.push('c53');
      if (reliance === 'deliverable') drivers.push('c51');
      if (dataScope === 'restricted' && reliedProbabilistic) drivers.push('c54');
      if (!drivers.length) drivers.push(dataScope === 'restricted' ? 'c52' : 'c51');
    } else {
      // Lane 2: rank failed conditions by severity.
      const severity = ['c55', 'host', 'c56', 'c53', 'c51', 'c54', 'c52', 'c57'];
      for (const id of severity) if (byId[id] && !byId[id].status.includes('pass')) drivers.push(id);
    }
    drivers.slice(0, 2).forEach((id) => { if (byId[id]) byId[id].driving = true; });
  }

  // ---- Unknowns the analyzer surfaced for confirmation --------------------
  const unknowns = [];
  if (!used.overridden.dataScope) unknowns.push({ dim: 'data scope', value: dataScope, why: 'Code can’t prove whether data is Client/Fund/Restricted.' });
  if (!used.overridden.reliance) unknowns.push({ dim: 'who relies on it', value: reliance, why: 'Code can’t see who depends on the output.' });
  if (dbWrite && !used.overridden.writeAuthority) unknowns.push({ dim: 'write target', value: writeAuthority, why: 'Code can’t tell a system of record from a scratch store.' });

  // ---- "What would make it lighter" — each demotion with the lane it WOULD
  // become, computed by re-running the resolver with that one change applied
  // (per the meeting: "make this one or two changes and then it becomes lane one").
  const lightenDefs = [
    { when: directAI, text: 'Route the AI through the approved company proxy instead of calling an outside model directly.', f: { directAI: false, proxyAI: true } },
    { when: backend, text: 'Serve it as a static page so there’s no custom server to run.', f: { backend: false } },
    { when: liveDataConnection && !backend, text: 'Snapshot the data into the workbook (paste-values) instead of keeping a live external connection.', f: { liveDataConnection: false } },
    { when: authoritativeWrite, text: 'Have it propose the change for you to apply — don’t let it update the system of record itself.', f: { dbWrite: false } },
    { when: reliedProbabilistic, text: 'Add a step where you review and accept each result before it’s used.', ua: { humanReview: true } },
    { when: reliance === 'deliverable', text: 'Use it as a personal draft helper you review, rather than sending its output straight to clients.', ua: { reliance: 'personal' } },
    { when: cdnScript, text: 'Bundle the outside script locally instead of loading it from a third-party CDN.', f: { cdnScript: false } },
    { when: outbound, text: 'Drop the calls to outside services, or get those hosts onto the approved allowlist.', f: { outbound: false } },
    { when: persistence && dataScope === 'restricted', text: 'Stop saving sensitive data on the device.', f: { persistence: false } },
  ];
  const lighten = verdictKey === 'lane1' ? [] : lightenDefs.filter((d) => d.when).map((d) => ({
    text: d.text,
    wouldBe: decide({ ...facts, ...(d.f || {}) }, { ...assumptions, ...(d.ua || {}) }).verdictKey,
  }));

  // ---- Certainty: what the code proves vs. what we had to assume -----------
  const assumed = conditions.filter((cc) => cc.assumption && !used.overridden[cc.assumption.kind]);
  const certainty = { proven: conditions.length - assumed.length, assumed: assumed.length, assumedIds: assumed.map((cc) => cc.id) };

  // ---- Confidence: cached base + the single-snippet adjustment, which depends on
  // the verdict. Copy the cached reasons so the bundle stays reusable across toggles.
  let confLevel = bundle.confBase.level;
  const confReasons = bundle.confBase.reasons.slice();
  if (confLevel !== 'low' && bundle.fileCount <= 1 && verdictKey !== 'lane1') {
    confLevel = confLevel === 'high' ? 'medium' : confLevel;
    confReasons.push('Based on a single small snippet — drop in the whole project for a firmer read.');
  }
  const confidence = { level: confLevel, reasons: confReasons };

  return {
    verdict: VERDICTS[verdictKey],
    tier,
    posture,
    pattern: bundle.pattern,
    conditions,
    assumptions: used,
    unknowns,
    lighten,
    certainty,
    confidence,
    buildTool: bundle.buildTool,
    meta: {
      label: bundle.meta.label,
      source: bundle.meta.source,
      fileCount: bundle.fileCount,
      repoMeta: bundle.meta.repoMeta,
      notes: bundle.meta.notes,
    },
  };
}

// Convenience: extract + resolve in one call (used by tests and any non-interactive
// caller). The interactive UI calls extractFacts once and resolve() per what-if toggle.
export function analyze(corpus, assumptions = {}) {
  return resolve(extractFacts(corpus), assumptions);
}
