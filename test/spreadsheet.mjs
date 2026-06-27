// Spreadsheet-analysis test suite.
//
//  Part A (always): engine verdicts on synthetic spreadsheet corpora — exercises the
//          ruleset + classify integration for VBA / formula / Power Query / connection
//          artifacts with no binary or zip dependency.
//  Part B (always): the OOXML/CSV extractors (extractFormulas, csvToArtifacts, …).
//  Part C (needs JSZip): a real round-trip — decode an embedded macro-enabled .xlsm,
//          unzip it, parse the OLE2 vbaProject.bin, MS-OVBA-decompress the module, and
//          confirm the workbook reaches the right Lane. Skipped (not failed) if the
//          vendored JSZip can't be loaded in this runtime.
//
// Run:  node test/spreadsheet.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { analyze } from '../src/engine/classify.js';
import {
  extractVbaModules, extractFormulas, parseWorkbookStructure, csvToArtifacts,
} from '../src/engine/spreadsheet.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(msg); console.log('  ✗ ' + msg); } }

// Build a spreadsheet corpus from synthetic artifact files.
function sheet(files, label = 'workbook.xlsm') {
  return { files, source: 'spreadsheet', label, meta: { kind: 'xlsm' }, notes: [] };
}
function verdict(files, want, msg, assumptions = {}) {
  const r = analyze(sheet(files), assumptions);
  ok(r.verdict.key === want, `${msg} — got ${r.verdict.key}, want ${want}`);
  return r;
}

// ── Part A: synthetic-corpus verdicts ─────────────────────────────────────────────────
console.log('Part A — engine verdicts on synthetic spreadsheet artifacts');

// Benign, deterministic, in-sheet-only macro on sensitive (NAV) data → Lane 1.
verdict([{ path: 'vba/Module1.bas', text:
  'Sub FormatFees()\n  Dim r As Long\n  For r = 2 To 100\n    Cells(r,5).Value = Round(Cells(r,3).Value * Cells(r,4).Value / 12, 2)\n    Cells(r,5).NumberFormat = "#,##0.00"\n  Next r\nEnd Sub' }],
  'lane1', 'benign NAV formatter macro');

// Deterministic recon worksheet formulas → Lane 1.
verdict([{ path: 'formulas/Recon.formulas', text:
  'B5: VLOOKUP(A5,Custodian!$A:$D,4,FALSE)\nC5: SUMIFS(Ledger!$E:$E,Ledger!$B:$B,A5)\nE5: IF(ABS(B5-C5)<0.005,"OK","BREAK")' }],
  'lane1', 'deterministic VLOOKUP/SUMIFS recon');

// Shell-out macro → Lane 2 (backend / §6).
verdict([{ path: 'vba/M.bas', text:
  'Sub R()\n  Set wsh = CreateObject("WScript.Shell")\n  wsh.Run "cmd.exe /c del x"\nEnd Sub' }],
  'lane2', 'WScript.Shell.Run shell-out');

// Win32 Declare → Lane 2.
verdict([{ path: 'vba/M.bas', text:
  'Private Declare PtrSafe Function URLDownloadToFile Lib "urlmon" (ByVal p As Long) As Long\nSub G()\n  URLDownloadToFile 0\nEnd Sub' }],
  'lane2', 'Declare Lib Win32 import');

// XMLHTTP to a non-AI external host (VBA call syntax, no parens) → Lane 2 (§5.6 outbound).
verdict([{ path: 'vba/M.bas', text:
  'Sub Fx()\n  Set http = CreateObject("MSXML2.XMLHTTP")\n  http.Open "GET", "https://fx.marketdata-example.com/latest", False\n  http.Send\nEnd Sub' }],
  'lane2', 'MSXML2.XMLHTTP outbound (no-paren Open)');

// Direct AI vendor call from VBA → Lane 2 (§5.5 + §5.6).
const ai = verdict([{ path: 'vba/M.bas', text:
  'Sub S()\n  Set http = CreateObject("MSXML2.XMLHTTP")\n  http.Open "POST", "https://api.openai.com/v1/chat/completions", False\n  http.Send "{""model"":""gpt-4o"",""messages"":[{""role"":""user"",""content"":""hi""}]}"\nEnd Sub' }],
  'lane2', 'direct OpenAI call from VBA');
ok(ai.conditions.find((c) => c.id === 'c55').status !== 'pass', 'OpenAI VBA fails §5.5 (direct AI)');

// Outlook email automation → Lane 2 (§5.6).
verdict([{ path: 'vba/M.bas', text:
  'Sub Mail()\n  Set ol = CreateObject("Outlook.Application")\n  Set mi = ol.CreateItem(0)\n  mi.To = "x@y.com"\n  mi.Send\nEnd Sub' }],
  'lane2', 'Outlook.Application email send');

// ADODB INSERT into a custody DB with investor/capital-call data → Approve.
const ins = verdict([{ path: 'vba/M.bas', text:
  'Sub Post()\n  Set cn = CreateObject("ADODB.Connection")\n  cn.Open "Provider=SQLOLEDB;Data Source=CUSTODYSQL01;Initial Catalog=CustodyProd;"\n  cn.Execute "INSERT INTO CapitalCalls (FundId, InvestorId, CallAmount) VALUES (1,2,1000)"\nEnd Sub' }],
  'approve', 'ADODB INSERT capital calls');
ok(ins.tier === 'Approve', 'ADODB INSERT reaches Approve tier');

// ADODB stored-proc write → Approve.
verdict([{ path: 'vba/M.bas', text:
  'Sub Post()\n  Set cn = CreateObject("ADODB.Connection")\n  cn.Open "Provider=SQLOLEDB;Data Source=GP01;Initial Catalog=Ledger;"\n  cn.Execute "EXEC dbo.usp_PostCapitalAccount @InvestorId=5"\nEnd Sub' }],
  'approve', 'ADODB stored-proc write');

// Read-only ODBC connection (SELECT) → Lane 2 via liveDataConnection (§6), NOT Approve.
const odbc = verdict([{ path: 'connections/connections.xml', text:
  '<connection id="1" name="ProdGL"><dbPr connection="DSN=PRODGL;UID=reader" command="SELECT AccountNo, Amount FROM gl.Balances"/></connection>' }],
  'lane2', 'read-only ODBC SELECT connection');
ok(odbc.conditions.find((c) => c.id === 'host').status !== 'pass', 'ODBC connection fails §6 host (live data connection)');

// Connection that MERGEs into the fund master → Approve.
verdict([{ path: 'connections/connections.xml', text:
  '<connection id="2"><dbPr connection="Provider=SQLOLEDB;Data Source=FUNDMASTER01;Initial Catalog=FundProd;" command="MERGE INTO FundNavMaster AS t USING #s AS s ON t.FundId=s.FundId WHEN MATCHED THEN UPDATE SET t.Nav=s.Nav;"/></connection>' }],
  'approve', 'connection MERGE into fund master');

// Power Query Sql.Database → Lane 2 (live data connection).
verdict([{ path: 'powerquery/GL.m', text:
  'section Section1;\nshared GL = let Source = Sql.Database("PRODSQL01","FundAccounting") in Source;' }],
  'lane2', 'Power Query Sql.Database');

// Power Query Web.Contents / SharePoint → Lane 2 (outbound).
verdict([{ path: 'powerquery/SP.m', text:
  'section Section1;\nshared SP = let Source = SharePoint.Files("https://contoso.sharepoint.com/sites/Ops") in Source;' }],
  'lane2', 'Power Query SharePoint.Files outbound');

// Excel-4 (XLM) macro with EXEC → Lane 2.
verdict([{ path: 'macrosheets/Macro1.xlm', text:
  'A1: EXEC("cmd.exe /c calc")\nA2: HALT()' }],
  'lane2', 'Excel-4 XLM EXEC');

// Macros present but unreadable → cautious Lane 2.
verdict([{ path: 'vba/_unreadable.bas', text:
  "' A VBA macro project is present but could not be read.\nVBA_PROJECT_PRESENT_UNREADABLE" }],
  'lane2', 'unreadable macro project');

// FALSE-POSITIVE TRAPS — these must stay Lane 1:
// Application.Run dispatching an in-workbook macro (not OS exec).
verdict([{ path: 'vba/M.bas', text:
  'Sub Recalc()\n  Application.Run "OtherMacro"\n  Range("A1").Value = WorksheetFunction.Sum(Range("B:B"))\nEnd Sub' }],
  'lane1', 'TRAP: Application.Run stays Lane 1');

// Read-only FSO existence check.
verdict([{ path: 'vba/M.bas', text:
  'Sub Chk()\n  Set fso = CreateObject("Scripting.FileSystemObject")\n  If fso.FileExists("C:\\in.txt") Then MsgBox "yes"\nEnd Sub' }],
  'lane1', 'TRAP: read-only FSO stays Lane 1');

// Local-path SaveAs (not a UNC share).
verdict([{ path: 'vba/M.bas', text:
  'Sub S()\n  ActiveWorkbook.SaveAs "C:\\Reports\\NAV.xlsx"\nEnd Sub' }],
  'lane1', 'TRAP: local-path SaveAs stays Lane 1');

// Same-firm intranet WEBSERVICE (gpfs carve-out).
verdict([{ path: 'formulas/S.formulas', text:
  'A1: WEBSERVICE("https://data.gpfundsolutions.com/rates")' }],
  'lane1', 'TRAP: same-firm WEBSERVICE stays Lane 1');

// Comment-only mention of Shell (must be stripped, no false positive).
verdict([{ path: 'vba/M.bas', text:
  "Sub Safe()\n  ' This does NOT call Shell or CreateObject anything\n  Range(\"A1\").Value = 1\nEnd Sub" }],
  'lane1', 'TRAP: Shell in a VBA comment is stripped');

// ── QA-hardening regressions (confirmed adversarial findings) ──
// WMI process execution must NOT slip to Lane 1 (evades Shell/WScript.Shell tokens).
verdict([{ path: 'vba/Wmi.bas', text:
  'Sub Launch()\n  Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")\n  svc.Get("Win32_Process").Create "cmd.exe /c robocopy x y"\nEnd Sub' }],
  'lane2', 'WMI Win32_Process.Create is caught (not a false Lane 1)');

// Power Query DB connectors beyond the old allowlist (PostgreSQL/MySQL/Db2/…) → Lane 2.
for (const provider of ['PostgreSQL', 'MySQL', 'Db2', 'Teradata', 'SapHana']) {
  verdict([{ path: 'powerquery/Q.m', text:
    `section Section1;\nshared Q = let Source = ${provider}.Database("host","db") in Source;` }],
    'lane2', `Power Query ${provider}.Database is a live connection`);
}

// Mapped network drive (Z:) save → Register/Lane 2; local C:\ stays Lane 1.
verdict([{ path: 'vba/Save.bas', text:
  'Sub S()\n  ActiveWorkbook.SaveCopyAs "Z:\\FundOps\\Archive\\NAVPack.xlsx"\nEnd Sub' }],
  'lane2', 'mapped-drive (Z:) SaveCopyAs → Register/Lane 2');
verdict([{ path: 'vba/Save.bas', text:
  'Sub S()\n  ActiveWorkbook.SaveAs "C:\\Temp\\scratch.xlsx"\nEnd Sub' }],
  'lane1', 'TRAP: local C:\\ SaveAs stays Lane 1');

// Loose connection-string fragment in benign defined-name / formula prose must NOT escalate.
verdict([{ path: 'names/workbook-structure.defnames', text:
  'Sheets: Cover, Data\nName Title: Quarterly Data Source = Custody Team Spreadsheet\nName Catalog: Initial Catalog = product list' }],
  'lane1', 'TRAP: "Data Source="/"Initial Catalog=" in a defined-name label stays Lane 1');
// …but the same string inside a real connections.xml DOES escalate.
verdict([{ path: 'connections/connections.xml', text:
  '<connection><dbPr connection="Provider=SQLOLEDB;Data Source=PRODSQL01;Initial Catalog=Fund;"/></connection>' }],
  'lane2', 'real connection string in connections.xml → Lane 2');

// ── Part B: extractor units ───────────────────────────────────────────────────────────
console.log('Part B — OOXML / CSV extractors');
const fx = extractFormulas('<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B9)</f></c><c r="B1"><f>WEBSERVICE(&quot;https://x.example.com&quot;)</f></c></row></sheetData></worksheet>');
ok(fx.length === 2 && fx[0].ref === 'A1' && /WEBSERVICE/.test(fx[1].formula), 'extractFormulas pulls cell formulas + unescapes');

const ws = parseWorkbookStructure('<workbook><sheets><sheet name="Capital Accounts"/><sheet name="NAV"/></sheets><definedNames><definedName name="rate">Sheet1!$A$1</definedName></definedNames></workbook>');
ok(ws.sheets.length === 2 && ws.sheets[0] === 'Capital Accounts' && ws.names[0].name === 'rate', 'parseWorkbookStructure reads sheets + defined names');

const inj = csvToArtifacts('name,note\nAcme,=cmd|\'/c calc\'!A1\nBeta,ok\n', 'data.csv');
ok(inj.some((f) => f.path.startsWith('data/') && f.path.endsWith('.csv')), 'csv: raw data artifact emitted');
ok(inj.some((f) => /injection\.formulas$/.test(f.path) && /cmd\|/.test(f.text)), 'csv: formula/DDE-injection cell detected');
const plain = csvToArtifacts('a,b\n1,2\n3,4\n', 'plain.csv');
ok(!plain.some((f) => /injection/.test(f.path)), 'csv: plain data has no injection artifact');
// Injection inside a quoted field that spans a physical newline is still detected.
const injNL = csvToArtifacts('name,note\n"multi\nline note","=cmd|\'/c calc\'!A0"\n', 'x.csv');
ok(injNL.some((f) => /injection\.formulas$/.test(f.path) && /cmd\|/.test(f.text)), 'csv: injection in a quoted multi-line field is detected');
// A free-text column with commas in a TAB file must not break delimiter detection.
const tsvInj = csvToArtifacts('id\tnote\n7\t=WEBSERVICE("http://x.example.com/a,b,c")\n', 'y.tsv');
ok(tsvInj.some((f) => /injection\.formulas$/.test(f.path) && /WEBSERVICE/.test(f.text)), 'tsv: delimiter detection survives comma-rich prose');

// ── Part B2: no code-corpus regression (spreadsheet detectors must stay scoped) ────────
console.log('Part B2 — code-corpus is never touched by spreadsheet detectors');
const codeCorpus = (p, text, src = 'upload') => ({ files: [{ path: p, text }], source: src, label: p, meta: { repoMeta: {} }, notes: [] });
ok(analyze(codeCorpus('report.js', 'const rows = await db.query("EXEC sp_GetMonthlyReport @m=3");')).verdict.key === 'lane1', 'code: EXEC sp_ in JS stays Lane 1 (STORED_PROC_EXEC scoped)');
ok(analyze(codeCorpus('app.js', 'const Web = { Contents: (x) => x }; Web.Contents(1); export const f = () => 2;')).verdict.key === 'lane1', 'code: local Web.Contents() stays Lane 1 (outbound scoped)');
ok(analyze(codeCorpus('src/analyze.m', 'connStr = "Driver={SQL};Data Source=SRV;Initial Catalog=DB;";\nx = 1 + 1;', 'github')).verdict.key === 'lane1', 'code: MATLAB .m connection string stays Lane 1 (bare-ext scoped to spreadsheets)');
ok(analyze(codeCorpus('Foo.cls', 'public class Foo { void run() { System.debug("x"); } }', 'github')).verdict.key === 'lane1', 'code: Apex .cls stays Lane 1');

// docx as a filename (not the library) must not auto-escalate to Approve.
verdict([{ path: 'vba/M.bas', text: 'Sub S()\n  ActiveWorkbook.SaveAs "C:\\reports\\out.docx"\nEnd Sub' }],
  'lane1', 'TRAP: .docx filename in VBA stays Lane 1');
// Plain .tsv data is inert (note role) -> Lane 1.
ok(analyze({ files: csvToArtifacts('a\tb\n1\t2\n', 'data.tsv'), source: 'spreadsheet', label: 'data.tsv', meta: {}, notes: [] }).verdict.key === 'lane1', 'plain .tsv data stays Lane 1');

// ── Part C: real .xlsm round-trip (CFB + MS-OVBA) ─────────────────────────────────────
console.log('Part C — real .xlsm round-trip (CFB + MS-OVBA via JSZip)');
let JSZip;
try {
  const require = createRequire(import.meta.url);
  require('../src/vendor/jszip.min.js'); // UMD: sets globalThis.JSZip as a side effect
  JSZip = globalThis.JSZip;
} catch (e) { /* leave undefined */ }

// extractVbaModules works on raw bytes without JSZip.
const vbaBin = Uint8Array.from(Buffer.from(fs.readFileSync(path.join(here, 'fixtures/vbaproject-shell.bin.b64'), 'utf8'), 'base64'));
const ext = extractVbaModules(vbaBin);
ok(ext.found && ext.modules.length >= 1, 'CFB: VBA project found in vbaProject.bin');
ok(ext.modules.some((m) => /WScript\.Shell/.test(m.source)), 'MS-OVBA: decompressed module source matches');
ok(!ext.incomplete, 'CFB: a healthy single-module project is not flagged incomplete');

// Malicious CFB header (forged sector shift) must be rejected cleanly — no crash / OOM.
const badCfb = new Uint8Array(4096);
[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1].forEach((b, i) => { badCfb[i] = b; });
badCfb[30] = 28; badCfb[31] = 0; badCfb[32] = 6; badCfb[33] = 0;  // sectorShift=28 (invalid)
const badRes = extractVbaModules(badCfb);
ok(badRes.found === false && badRes.modules.length === 0, 'CFB: forged sector shift rejected, no crash/OOM');

// A self-referencing DIFAT continuation pointer + forged numDifatSectors must terminate fast
// (cycle detection + maxSectors caps), not inflate the FAT to gigabytes.
{
  const buf = new Uint8Array(2048);
  [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1].forEach((b, i) => { buf[i] = b; });
  const wu16 = (o, v) => { buf[o] = v & 255; buf[o + 1] = (v >> 8) & 255; };
  const wu32 = (o, v) => { buf[o] = v & 255; buf[o + 1] = (v >> 8) & 255; buf[o + 2] = (v >> 16) & 255; buf[o + 3] = (v >> 24) & 255; };
  wu16(30, 9); wu16(32, 6);            // 512-byte sectors, 64-byte mini sectors
  wu32(72, 0xFFFFFFFF);                // numDifatSectors = ~4e9 (forged)
  wu32(68, 0);                         // firstDifatSector = sector 0
  wu32(48, 1);                         // firstDirSector
  wu32(512 + 127 * 4, 0);             // sector 0's continuation word self-loops to sector 0
  const t = Date.now();
  const r = extractVbaModules(buf);
  ok(Date.now() - t < 1000 && Array.isArray(r.modules), 'CFB: self-looping DIFAT terminates fast (no OOM/hang)');
}

if (JSZip && typeof JSZip.loadAsync === 'function') {
  const { loadFromSpreadsheet } = await import('../src/engine/spreadsheet.js');
  const xlsm = Uint8Array.from(Buffer.from(fs.readFileSync(path.join(here, 'fixtures/shell-macro.xlsm.b64'), 'utf8'), 'base64'));
  xlsm.name = 'shell-macro.xlsm';
  const corpus = await loadFromSpreadsheet(xlsm);
  ok(corpus.files.some((f) => f.path.startsWith('vba/') && /WScript\.Shell/.test(f.text)), 'E2E: workbook unzip + VBA extraction');
  const r = analyze(corpus, {});
  ok(r.verdict.key === 'lane2', `E2E: shell-macro workbook -> Lane 2 (got ${r.verdict.key})`);
} else {
  console.log('  (skipped JSZip end-to-end — vendored JSZip not loadable in this runtime)');
}

// ── summary ───────────────────────────────────────────────────────────────────────────
console.log(`\nSpreadsheet suite: ${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ''}`);
if (fail) { console.log('\nFailures:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
