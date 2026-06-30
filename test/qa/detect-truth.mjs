// detect-truth.mjs — ground-truth detection across languages. Each case asserts a
// specific §-condition outcome (or auto-assumption) that the engine derives directly
// from code. Positives must trip the relevant condition; benign twins must not.
// This is the false-positive / false-negative tripwire for the detectors.

import { analyze } from '../../src/engine/classify.js';
import { T, fileCorpus } from './_harness.mjs';

const C = (r, id) => r.conditions.find((c) => c.id === id) || { status: '?' };
const passes = (r, id) => C(r, id).status === 'pass';

export async function run() {
  const t = T('detect-truth');
  const a = (path, code) => analyze(fileCorpus(path, code));

  // ---- §5.5 direct AI calls: positives FAIL c55, negatives PASS c55 ---------
  const aiPos = [
    ['sdk-import.js', "import OpenAI from 'openai';\nconst c = new OpenAI();"],
    ['sdk-require.js', "const OpenAI = require('openai');"],
    ['payload-fetch.js', "fetch('https://x.example.com/v1', {method:'POST', body: JSON.stringify({model:'gpt-4', messages:[{role:'user', content:'hi'}]})})"],
    ['payload-axios.js', "axios.post('https://y.example.com', {model:'claude-3', messages:[{role:'system', content:'x'}]})"],
    ['vendor-host.js', "await fetch('https://api.openai.com/v1/chat/completions', {method:'POST'})"],
    ['anthropic-host.js', "fetch('https://api.anthropic.com/v1/messages', {method:'POST'})"],
    ['py-openai.py', "from openai import OpenAI\nclient = OpenAI()\nclient.chat.completions.create(model='gpt-4', messages=[])"],
    ['gemini-host.js', "fetch('https://generativelanguage.googleapis.com/v1/models', {method:'POST'})"],
  ];
  for (const [p, code] of aiPos) t.ok(`directAI POS ${p}: c55 fails`, !passes(a(p, code), 'c55'));

  const aiNeg = [
    ['proxy.js', "fetch('/api/chat', {method:'POST', body: JSON.stringify({model:'gpt-4', messages:[{role:'user', content:'x'}]})})"],
    ['format.js', "export const fmt = n => new Intl.NumberFormat().format(n)"],
    ['readme.md', "This app calls https://api.openai.com with model gpt-4 messages role user content."],
    ['model-word.js', "const model = carModels.find(m => m.year === 2020)"],
    ['ui.jsx', "function App(){ return <div onClick={save}>hello</div> }"],
  ];
  for (const [p, code] of aiNeg) t.ok(`directAI NEG ${p}: c55 passes`, passes(a(p, code), 'c55'));

  // approved proxy is the one allowed AI shape -> c55 passes
  t.ok('proxy /api/chat keeps c55 pass', passes(a('proxy.js', "fetch('/api/chat',{method:'POST',body:JSON.stringify({model:'gpt-4',messages:[{role:'user',content:'x'}]})})"), 'c55'));

  // ---- §6 backend runtime: positives FAIL host, negatives PASS host --------
  const backendPos = [
    ['express.js', "const express = require('express'); const app = express(); app.listen(3000)"],
    ['express-imp.js', "import express from 'express';\nconst app = express();\napp.get('/x', (req,res)=>res.send('ok'));\napp.listen(8080)"],
    ['flask.py', "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef home(): return 'hi'"],
    ['fastapi.py', "from fastapi import FastAPI\napp = FastAPI()"],
    ['django.py', "from django.urls import path\nurlpatterns = []"],
    ['go-http.go', 'package main\nimport "net/http"\nfunc main(){ http.ListenAndServe(":8080", nil) }'],
    ['gin.go', 'r := gin.Default()\nr.Run(":8080")'],
    ['dotnet.cs', '[ApiController]\npublic class C : ControllerBase { }'],
    ['php-index.php', '<?php echo "hello"; ?>'],
    ['nest.ts', "import { Module } from '@nestjs/common';"],
    ['nextapi/app/api/x/route.ts', "export async function GET(){ return Response.json({ok:true}) }"],
  ];
  for (const [p, code] of backendPos) t.ok(`backend POS ${p}: host fails`, !passes(a(p, code), 'host'));

  const backendNeg = [
    ['client.js', "document.getElementById('app').textContent = 'hi'"],
    ['format.ts', "export function fmt(n: number){ return n.toFixed(2) }"],
    ['styles.css', ".btn { color: red }"],
    ['data.json', '{"a":1,"b":2}'],
  ];
  for (const [p, code] of backendNeg) t.ok(`backend NEG ${p}: host passes`, passes(a(p, code), 'host'));

  // ---- §5.3 writes to a system of record: positives FAIL c53 ----------------
  const writePos = [
    ['sql-insert.js', "await db.query(`INSERT INTO ledger (amt) VALUES (1)`)"],
    ['sql-update.sql', "UPDATE positions SET nav = 100 WHERE id = 1"],
    ['prisma.js', "await prisma.user.create({ data: { name: 'x' } })"],
    ['mongo.js', "await coll.insertOne({ amount: 1 })"],
    ['put.js', "fetch('/api/records/1', { method: 'PUT', body: '{}' })"],
    ['delete.js', "fetch('/api/users/1', { method: 'DELETE' })"],
    ['ext-post-write.js', "fetch('https://api.acme.com/invoices', { method: 'POST', body: '{}' })"],
    ['gorm.go', "db.Create(&Ledger{Amount: 1})"],
    ['pandas.py', "df.to_sql('ledger', con, if_exists='append')"],
    ['efcore.cs', "_ctx.Add(entity);\nawait _ctx.SaveChangesAsync();"],
  ];
  for (const [p, code] of writePos) t.ok(`write POS ${p}: c53 not pass`, !passes(a(p, code), 'c53'));

  const writeNeg = [
    ['read.js', "const rows = await db.query('SELECT * FROM ledger')"],
    ['proxy-post.js', "fetch('/api/chat', { method: 'POST', body: '{}' })"],
    ['ai-create.js', "const r = await openaiClient.messages.create({ model: 'x' })"],
    ['format.js', "const total = items.reduce((a,b)=>a+b, 0)"],
    ['graphql-query.js', "fetch('https://api.acme.com/graphql', { method: 'POST', body: q })"],
  ];
  for (const [p, code] of writeNeg) t.ok(`write NEG ${p}: c53 passes`, passes(a(p, code), 'c53'));

  // ---- §5.2 restricted data: auto dataScope flips restricted/general --------
  const restrictedPos = [
    ['inv.js', "const investorCapitalAccount = load()"],
    ['nav.js', "const NAV = computeNav(positions)"],
    ['ssn.py', "ssn = applicant['SSN']"],
    ['fund.ts', "interface FundHolding { fundNav: number }"],
    ['snake.js', "const investor_capital_account = 1"],
    ['custodian.js', "const x = custodian.ledger"],
    ['mnpi.js', "const mnpiRecord = load(); send(mnpiRecord)"],
  ];
  for (const [p, code] of restrictedPos) t.eq(`restricted POS ${p}`, a(p, code).assumptions.dataScope, 'restricted');

  const restrictedNeg = [
    ['styles.css', ".restricted { display: none } .confidential-banner { color: red }"],
    ['nav.html', "<nav class='navbar'><a>Home</a></nav>"],
    ['navvar.js', "const navbar = document.querySelector('.navbar'); let navigation = true"],
    ['format.js', "const fmt = n => n.toFixed(2)"],
    ['portfolio-css.html', "<div class='portfolio-grid'>art</div>"],
  ];
  for (const [p, code] of restrictedNeg) t.eq(`restricted NEG ${p}`, a(p, code).assumptions.dataScope, 'general');

  // ---- false-positive regressions fixed during go-live QA -------------------
  // bare `pg`/`mysql` identifiers are NOT a live DB connection (must stay host-pass)
  t.ok('let pg = 1 (page counter) stays self-contained', passes(a('p.js', 'let pg = 1; pg = pg + 1; const off = pg * 10'), 'host'));
  t.ok("dbType='mysql' string stays self-contained", passes(a('p.js', "const dbType = 'mysql'; const label = dbType.toUpperCase()"), 'host'));
  // real driver imports still flag the §6 live-connection
  t.ok("require('pg') still flags §6", !passes(a('db.js', "const { Pool } = require('pg'); const p = new Pool()"), 'host'));
  t.ok('import psycopg2 still flags §6', !passes(a('db.py', 'import psycopg2\nconn = psycopg2.connect(DSN)'), 'host'));
  // html2canvas (screenshot) is NOT an authoritative deliverable
  t.ok('html2canvas screenshot is not a deliverable (not Approve)', a('s.js', "import html2canvas from 'html2canvas'; html2canvas(el)").verdict.key !== 'approve');
  // a <?php string inside JS is not a backend
  t.ok('<?php inside a JS string is not a backend', passes(a('tpl.js', "const sample = '<?php echo 1; ?>'; render(sample)"), 'host'));
  // importing an auth provider is not an SSO bypass (§5.6 stays pass on that alone)
  t.ok('auth0 import alone is not §5.6 public-auth', passes(a('auth.js', "import { Auth0Client } from '@auth0/auth0-spa-js'"), 'c56'));
  // case/whitespace-variant assumptions are honored, not dropped to the lighter auto
  t.ok('assumption "RESTRICTED " (case/space) is honored', analyze(fileCorpus('x.js', 'const x=1'), { dataScope: ' RESTRICTED ' }).assumptions.dataScope === 'restricted');

  // ---- doc/test role scoping: signals in docs/tests must not ship -----------
  t.ok('README with INSERT does not set a write', passes(a('README.md', 'Run `INSERT INTO ledger VALUES (1)` to seed.'), 'c53'));
  t.ok('*.test.js with direct AI does not ship', passes(a('x.test.js', "fetch('https://api.openai.com/v1', {method:'POST'})"), 'c55'));

  return t.st;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { printResult } = await import('./_harness.mjs');
  printResult(await run());
}
