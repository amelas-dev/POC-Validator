// Fixtures for the governance-aware merge tests (overlap.js / merge.js / core.js).
// Small, deterministic corpora with KNOWN governance outcomes so the tests can assert the
// exact Lane delta + the evidence file:line that drives it.

const corpus = (label, files, source = 'upload') => ({ source, label, files: files.map(([path, text]) => ({ path, text, bytes: text.length })), meta: {}, notes: [] });

// BENIGN, self-contained currency formatter — no backend / AI / outbound / restricted
// data -> Lane 1 (the light path).
export const benignA = corpus('fee-formatter', [[
  'index.html',
  '<!doctype html>\n<h2>Quarterly fee summary</h2>\n<input id="in" placeholder="amount">\n<button id="fmt">Format</button>\n<pre id="out"></pre>\n<script>\n  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });\n  document.getElementById("fmt").addEventListener("click", () => {\n    out.textContent = usd.format(parseFloat(document.getElementById("in").value) || 0);\n  });\n</script>\n',
]]);

// A second, DIFFERENT benign Lane-1 tool (a list de-duplicator) — disjoint from benignA.
export const benignB = corpus('list-dedupe', [[
  'dedupe.js',
  'export function dedupe(rows) {\n  const seen = new Set();\n  return rows.filter((r) => { const k = String(r).trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });\n}\n',
]]);

// A near-duplicate of benignA: identical logic, reformatted + comments added. With
// comment/whitespace-aware normalization this dedupes to benignA's index.html.
export const benignAReformatted = corpus('fee-formatter-v2', [[
  'index.html',
  '<!doctype html>\n<!-- quarterly fee formatter, tidied -->\n<h2>Quarterly fee summary</h2>\n<input id="in" placeholder="amount">\n<button id="fmt">Format</button>\n<pre id="out"></pre>\n<script>\n    const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });   // formatter\n    document.getElementById("fmt").addEventListener("click", () => {\n        out.textContent = usd.format(parseFloat(document.getElementById("in").value) || 0);\n    });\n</script>\n',
]]);

// A Lane-2 POC: a direct runtime call to a public LLM vendor host (api.openai.com) -> trips
// the §5.5 "runtime-ai-direct-vendor-host" signal -> fails §5.5 -> Lane 2. The disqualifying
// evidence is the fetch() line in src/api.js.
export const aiPoc = corpus('ai-helper', [[
  'src/api.js',
  'export async function ask(question) {\n  const res = await fetch("https://api.openai.com/v1/chat/completions", {\n    method: "POST",\n    headers: { Authorization: "Bearer " + window.KEY, "Content-Type": "application/json" },\n    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: question }] }),\n  });\n  return (await res.json()).choices[0].message.content;\n}\n',
]]);

export const poc = (c, id) => ({ id: id || c.label, label: c.label, source: c.source, corpus: c });
