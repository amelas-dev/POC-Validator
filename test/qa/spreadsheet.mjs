// spreadsheet.mjs — the workbook/CSV path. Robustness on malformed/huge/edge input
// (must never throw), correct delimiter handling, RFC-ish quoting, and the formula/
// DDE-injection detector that flags Excel-interpreted cells (=,+,-,@ ... ).

import {
  isSpreadsheet, csvToArtifacts, extractFormulas, parseWorkbookStructure, extractVbaModules, loadFromSpreadsheet,
} from '../../src/engine/spreadsheet.js';
import { T, fakeFile } from './_harness.mjs';

const hasInjection = (files) => files.some((f) => /injection\.formulas$/.test(f.path));
const dataFile = (files) => files.find((f) => f.path.startsWith('data/'));

export async function run() {
  const t = T('spreadsheet');

  // ---- isSpreadsheet ---------------------------------------------------------
  for (const ok of ['x.csv', 'x.tsv', 'b.xlsx', 'b.xlsm', 'b.xlsb', 'b.xltx', 'b.xltm', 'old.xls', 'PATH/To/Thing.XLSX']) t.ok(`isSpreadsheet ${ok}`, isSpreadsheet(ok));
  for (const no of ['x.js', 'x.txt', 'x.pdf', 'x', '', null, undefined, 'x.xlsxx']) t.falsy(`not spreadsheet ${JSON.stringify(no)}`, isSpreadsheet(no));

  // ---- csvToArtifacts: always yields a data artifact, never throws ----------
  t.notThrows('csv empty string', () => csvToArtifacts('', 'a.csv'));
  t.notThrows('csv null', () => csvToArtifacts(null, 'a.csv'));
  t.notThrows('csv undefined name', () => csvToArtifacts('a,b', undefined));
  t.truthy('csv yields data file', dataFile(csvToArtifacts('a,b\n1,2', 'a.csv')));
  t.eq('csv data path', dataFile(csvToArtifacts('a,b', 'sales.csv')).path, 'data/sales.csv');

  // ---- formula / DDE injection detection ------------------------------------
  t.truthy('flags =SUM injection', hasInjection(csvToArtifacts('name,val\nfoo,=SUM(A1)', 'a.csv')));
  t.truthy('flags @WEBSERVICE injection', hasInjection(csvToArtifacts('x\n@WEBSERVICE("http://e.com")', 'a.csv')));
  t.truthy('flags =cmd DDE', hasInjection(csvToArtifacts('a\n=cmd|\'/c calc\'!A1', 'a.csv')));
  t.truthy('flags -2+3+cmd', hasInjection(csvToArtifacts('a\n-2+3+cmd|\'/c\'!A1', 'a.csv')));
  t.falsy('benign data: no injection', hasInjection(csvToArtifacts('name,age\nAlice,30\nBob,40', 'a.csv')));
  t.falsy('numeric =1+1 (no letter/paren) not flagged', hasInjection(csvToArtifacts('a\n=1+1', 'a.csv')));

  // ---- delimiter handling ----------------------------------------------------
  t.notThrows('tsv parsed', () => csvToArtifacts('a\tb\n1\t2', 'x.tsv'));
  t.notThrows('ambiguous ext counts delimiter', () => csvToArtifacts('a\tb\tc\n1\t2\t3', 'x.dat'));
  // a quoted field full of commas must not flip a tab-delimited file to comma
  t.notThrows('quoted commas do not confuse delimiter', () => csvToArtifacts('"a,b,c,d,e"\tx\n1\t2', 'x.dat'));

  // ---- RFC-ish quoting: embedded newlines/commas/escaped quotes -------------
  t.notThrows('embedded newline in quoted field', () => csvToArtifacts('"line1\nline2",b\n1,2', 'a.csv'));
  t.notThrows('escaped doubled quotes', () => csvToArtifacts('"she said ""hi""",b', 'a.csv'));
  // an injection hidden after a quoted multi-line field is still caught
  t.truthy('injection after quoted newline still flagged', hasInjection(csvToArtifacts('"a\nb",c\nx,=SUM(Z9)', 'a.csv')));

  // ---- BOM + truncation ------------------------------------------------------
  t.notThrows('BOM-prefixed csv', () => csvToArtifacts('﻿name,age\nA,1', 'a.csv'));
  const huge = csvToArtifacts('h\n' + 'x,'.repeat(400 * 1024), 'big.csv');
  t.truthy('huge csv truncates the data artifact', dataFile(huge).truncated === true);

  // ---- XML / VBA parsers never throw on malformed input ---------------------
  t.notThrows('extractFormulas valid', () => extractFormulas('<worksheet><sheetData><row><c r="A1"><f>SUM(B1:B2)</f><v>3</v></c></row></sheetData></worksheet>'));
  t.notThrows('extractFormulas malformed', () => extractFormulas('<sheetData><c><f>SUM(' + 'x'.repeat(1000)));
  t.notThrows('extractFormulas empty', () => extractFormulas(''));
  t.notThrows('parseWorkbookStructure valid', () => parseWorkbookStructure('<workbook><sheets><sheet name="S1" sheetId="1"/></sheets></workbook>'));
  t.notThrows('parseWorkbookStructure malformed', () => parseWorkbookStructure('<workbook><sheets><sheet name='));
  t.notThrows('extractVbaModules garbage bytes', () => extractVbaModules(new Uint8Array([0, 1, 2, 3, 255, 254, 7, 8])));
  t.notThrows('extractVbaModules empty', () => extractVbaModules(new Uint8Array(0)));

  // ---- ReDoS budgets: pathological unterminated openers stay bounded --------
  await t.within('redos: extractFormulas unterminated <c> openers', 2000, async () => {
    extractFormulas('<f/>' + '<c r="A1" '.repeat(120000));   // 120k openers, no closing >
  });
  await t.within('redos: parseWorkbookStructure unterminated <definedName>', 2000, async () => {
    parseWorkbookStructure('<definedName '.repeat(120000));
  });
  await t.within('redos: parseWorkbookStructure unterminated <sheet>', 2000, async () => {
    parseWorkbookStructure('<sheet '.repeat(120000));
  });

  // ---- loadFromSpreadsheet end-to-end for CSV (no zip needed) ---------------
  const csvCorpus = await loadFromSpreadsheet(fakeFile('quarter.csv', 'region,sales\nEast,100\nWest,200'));
  t.eq('csv loader source', csvCorpus.source, 'spreadsheet');
  t.truthy('csv loader yields data file', csvCorpus.files.some((f) => f.path.startsWith('data/')));
  t.notThrowsAsync('xls without VBA degrades cleanly', async () => { await loadFromSpreadsheet(fakeFile('legacy.xls', 'x'), () => {}, {}); });
  // corrupt OOXML (not a real zip) returns a graceful summary, not a crash
  t.notThrowsAsync('corrupt xlsx returns graceful note', async () => {
    await loadFromSpreadsheet(fakeFile('broken.xlsx', 'not a zip'), () => {}, { JSZip: { async loadAsync() { throw new Error('bad zip'); } } });
  });

  return t.st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { printResult } = await import('./_harness.mjs');
  printResult(await run());
}
