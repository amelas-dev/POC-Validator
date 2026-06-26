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
const STRONG_RESTRICTED = /\b(investors?|LPs?|GPs?|capital\s*accounts?|capital\s*calls?|NAV|AUM|subscriptions?|redemptions?|custodian|ledger|holdings?|mandates?|fund\s*(nav|id|name|position|holdings?)|client[_\s-]?(name|id|account|holding|portfolio)|SSN|EIN|TIN|account\s*number|routing\s*number|PII|PHI|MNPI|material\s*non[-\s]public|restricted|confidential)\b/i;
const VENDOR_HOST = /(api\.(anthropic|openai|cohere|mistral|groq)\.|[a-z0-9-]+\.openai\.azure\.com|openai\.azure\.com|generativelanguage\.googleapis\.com|api-inference\.huggingface\.co|api\.replicate\.com|bedrock(-runtime)?\.[a-z0-9-]+\.amazonaws\.com)/i;
const STRONG_RELIANCE_EXPORT = /(jspdf|pdfkit|exceljs|xlsx\.write|pptxgenjs|\bdocx\b|exportto(excel|pdf|csv)|generate\w*(report|statement|deliverable|pack|filing|invoice))/i;
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
    hosting: 'Shared Hosting (tools.gpfundsolutions.com) · login required · a quick review before it publishes · you stay responsible · 90-day check-in',
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
// Real source-of-truth writes: SQL/ORM/driver/BaaS evidence. Deliberately does
// NOT match a bare `.create(`/`.save(` — those collide with AI SDKs
// (messages.create) and generic builders; ORM writes are caught via the driver
// import or a specific mutation method instead.
const DB_ORM_WRITE = /(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert|merge\s+into|create\s+table|alter\s+table|prisma\.[a-z]+\.(create|update|upsert|delete)|\.(insertone|insertmany|updateone|updatemany|deleteone|deletemany|bulkcreate|findoneandupdate)\s*\(|createpool\s*\(|createconnection\s*\(|database_url|(postgres|postgresql|mysql|mongodb):\/\/|\b(pg|mysql2?|sqlite3|mongodb|mongoose|psycopg2|sqlalchemy|knex|sequelize|@prisma\/client)\b)/i;
// A genuine backend runtime — framework, listener, serverless dir, or container —
// not merely a client file that happens to be named app.js / main.js / server.js.
const BACKEND_STRONG = /(import\s+express|require\(['"]express['"]\)|"express"\s*:|\bfastify\b|@nestjs\/|\bkoa\b|from\s+flask\s+import|flask\(__name__\)|from\s+fastapi\s+import|fastapi\s*\(|app\.listen\s*\(|http\.createserver|createserver\s*\(|app\.(get|post|put|delete)\s*\()/i;
const BACKEND_PATH = /(pages\/api\/|app\/api\/.*\/route\.(js|ts)|netlify\/functions\/|(^|\/)functions\/.*\.(js|ts)$|(^|\/)dockerfile$|docker-compose|(^|\/)procfile$)/i;

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
    host: !f.backend,
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

export function analyze(corpus, assumptions = {}) {
  const scan = scanCorpus(corpus);
  const S = scan.signals;
  const files = (corpus && corpus.files) || [];
  const grep = (re) => files.some((f) => re.test(f.text || ''));
  const fired = (id) => !!(S[id] && S[id].firedRuntime);
  const entry = (id) => S[id];
  const evOf = (...ids) => {
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

  // ---- Code-certain technical facts ---------------------------------------
  const directHost = anyEvidenceMatches(entry('runtime-ai-direct-vendor-host'), VENDOR_HOST);
  const sdkImport = fired('runtime-ai-vendor-sdk-import');
  const clientKey = fired('client-side-model-api-key');
  const directAI = directHost || sdkImport || clientKey;
  const proxyAI = entry('approved-enterprise-proxy') && entry('approved-enterprise-proxy').fired && !directAI;
  const localML = fired('logic-probabilistic-ml-inference');
  const backendEv = entry('backend-server-present')?.evidence || [];
  const backend = backendEv.some((e) => BACKEND_STRONG.test(e.text)) || backendEv.some((e) => BACKEND_PATH.test(e.path));
  // A write to a system of record needs DB/ORM/SQL or BaaS evidence, or a
  // mutating call to an external host — NOT a POST to the same-origin proxy.
  const dbOrmWrite = (entry('db-source-of-truth-write')?.evidence || []).some((e) => DB_ORM_WRITE.test(e.text));
  const dbWrite = dbOrmWrite || fired('backend-as-a-service-write') || grep(MUTATING_EXTERNAL) || grep(METHOD_WRITE);
  const cdnScript = fired('third-party-cdn-script') || fired('third-party-analytics-telemetry');
  const outbound = fired('outbound-network-call-nonallowlisted');
  const persistence = fired('client-persistence-sensitive');
  const publicAuth = anyEvidenceMatches(entry('sso-gating-posture'), PUBLIC_AUTH);

  // ---- Logic posture (STAR §3.2) ------------------------------------------
  const extraction = fired('logic-probabilistic-extraction-parsing') || grep(EXTRACTION_EXTRA);
  const qa = fired('logic-probabilistic-qa-retrieval');
  const drafting = fired('logic-probabilistic-summarize-draft');
  const deterministic = fired('logic-deterministic-green');
  const probabilistic = directAI || proxyAI || localML || extraction || qa || drafting;
  // Is probabilistic output exported/written in a batch (no human sees each
  // result), rather than shown interactively for review? (posture itself comes
  // from the resolver below.)
  const silentBatch = probabilistic && grep(SILENT_BATCH);

  // ---- Dimensions code cannot prove -> auto-defaults, user-overridable -----
  const restrictedStrong = anyEvidenceMatches(entry('data-scope-restricted-keywords'), STRONG_RESTRICTED);
  const relianceExport = anyEvidenceMatches(entry('reliance-deliverable-markers'), STRONG_RELIANCE_EXPORT);
  const relianceShare = anyEvidenceMatches(entry('reliance-shared-repeatable-register'), STRONG_RELIANCE_SHARE);

  // Bundle the code-derived facts and let the pure resolver do STEP 1 + STEP 2.
  const facts = {
    directAI, proxyAI, localML, backend, dbWrite, cdnScript, outbound, persistence, publicAuth,
    extraction, qa, drafting, deterministic, probabilistic, silentBatch,
    restrictedStrong, relianceExport, relianceShare,
  };
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
      id: 'host', ref: '§6', title: backend ? 'Custom server runtime' : 'Self-contained front-end',
      pass: pass.host,
      sentence: backend
        ? 'Runs its own server process, so it can’t share the static host — it needs an isolated container.'
        : 'Builds to plain files that any shared host can serve — nothing to run on the server.',
      ev: backend ? evOf('backend-server-present') : [],
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
            ? 'Configures public/consumer auth that bypasses GPFS SSO.'
            : 'No third-party scripts and no outbound calls beyond same-origin — runs cleanly behind SSO.',
      ev: cdnScript ? evOf('third-party-cdn-script', 'third-party-analytics-telemetry')
        : outbound ? evOf('outbound-network-call-nonallowlisted') : [],
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

  // ---- Pattern classification (informational "Looks like…") ---------------
  let pattern = 'Utility';
  if (qa) pattern = 'Document Q&A / retrieval';
  else if (extraction) pattern = 'Extraction / parsing';
  else if (drafting || directAI || proxyAI) pattern = 'Drafting / summarizing';
  else if (localML) pattern = 'ML scoring / inference';
  else if (dbWrite || backend) pattern = 'Data entry / integration';
  else if (anyEvidenceMatches(entry('logic-deterministic-green'), /intl\.numberformat|tolocalestring|tofixed|date-fns|dayjs|\bformat\b/i) || fired('numeric-mutation-downstream')) pattern = 'Data formatting';
  else if (anyEvidenceMatches(entry('logic-deterministic-green'), /\bvalidate\w*\b|\bzod\b|\byup\b|\bjoi\b|\.test\(/i)) pattern = 'Data validation';
  else if (deterministic) pattern = 'Data entry / formatting';

  // ---- Unknowns the analyzer surfaced for confirmation --------------------
  const unknowns = [];
  if (!used.overridden.dataScope) unknowns.push({ dim: 'data scope', value: dataScope, why: 'Code can’t prove whether data is Client/Fund/Restricted.' });
  if (!used.overridden.reliance) unknowns.push({ dim: 'who relies on it', value: reliance, why: 'Code can’t see who depends on the output.' });
  if (dbWrite && !used.overridden.writeAuthority) unknowns.push({ dim: 'write target', value: writeAuthority, why: 'Code can’t tell a system of record from a scratch store.' });

  const buildTool = entry('build-tool-ai-attribution') && entry('build-tool-ai-attribution').fired
    ? (entry('build-tool-ai-attribution').evidence[0]?.text || 'AI-assisted build') : null;

  // ---- "What would make it lighter" — each demotion with the lane it WOULD
  // become, computed by re-running the resolver with that one change applied
  // (per the meeting: "make this one or two changes and then it becomes lane one").
  const lightenDefs = [
    { when: directAI, text: 'Route the AI through the approved company proxy instead of calling an outside model directly.', f: { directAI: false, proxyAI: true } },
    { when: backend, text: 'Serve it as a static page so there’s no custom server to run.', f: { backend: false } },
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

  return {
    verdict: VERDICTS[verdictKey],
    tier,
    posture,
    pattern,
    conditions,
    assumptions: used,
    unknowns,
    lighten,
    certainty,
    buildTool,
    meta: {
      label: (corpus && corpus.label) || 'POC',
      source: (corpus && corpus.source) || 'upload',
      fileCount: scan.fileCount,
      repoMeta: (corpus && corpus.meta) || {},
      notes: (corpus && corpus.notes) || [],
    },
  };
}
