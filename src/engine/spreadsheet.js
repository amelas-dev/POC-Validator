// spreadsheet.js — turn a workbook (.xlsm/.xlsx/.xlsb/.xls) or a CSV/TSV into the SAME
// normalized corpus the code classifier analyzes, by extracting the *tools* hidden inside
// a spreadsheet and presenting each as a synthetic text "file":
//
//   • VBA macros        -> vba/<Module>.bas | .cls   (the real code accountants write)
//   • cell formulas     -> formulas/<Sheet>.formula  (WEBSERVICE/RTD/external links/DDE)
//   • data connections  -> connections/connections.xml (ODBC/OLEDB/web queries + SQL)
//   • Power Query (M)    -> powerquery/<Query>.m       (Sql.Database/Web.Contents/…)
//   • Excel-4 macros     -> macrosheets/<Sheet>.xlm    (EXEC/CALL/REGISTER)
//   • workbook structure -> names/workbook-structure   (sheet + defined names, ext links)
//
// Those synthetic files flow through the identical scan.js + classify.js pipeline, so a
// macro that shells out, a query that writes to a custody DB, or a formula that calls an
// outside service is triaged with the SAME rigor as source code.
//
// Everything runs locally (in the browser, or in Node for tests). The only dependency is
// the vendored JSZip (a workbook is a zip; an .xls / vbaProject.bin is an OLE2 compound
// file we parse ourselves). The CFB + MS-OVBA VBA extractor below is validated byte-for-
// byte against `olevba` (the industry-standard parser) on real Office files.

const MAX_TEXT_BYTES = 512 * 1024;     // cap any single synthetic artifact
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_FORMULAS_PER_SHEET = 2500;
const MAX_VBA_BYTES = 4 * 1024 * 1024; // guard the decompressor against a runaway stream

// ===========================================================================
//  OLE2 / Compound File Binary (CFB) reader — just enough to reach the VBA project.
//  Validated against olevba on real .docm/.xlsm vbaProject.bin streams.
// ===========================================================================
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;

function concatBytes(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function parseCfb(bytes) {
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a compound file');
  const sectorShift = u16(bytes, 30); const sectorSize = 1 << sectorShift;
  const miniSectorShift = u16(bytes, 32); const miniSectorSize = 1 << miniSectorShift;
  // The CFB spec permits ONLY 512- or 4096-byte sectors (shift 9 or 12) and 64-byte mini
  // sectors (shift 6). Reject anything else BEFORE deriving sizes — a forged shift like 28
  // would make sectorSize ~256MB and the FAT loop allocate gigabytes (OOM DoS).
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('invalid CFB sector shift');
  if (miniSectorShift !== 6) throw new Error('invalid CFB mini-sector shift');
  const firstDirSector = u32(bytes, 48);
  const miniCutoff = u32(bytes, 56);
  const firstMiniFatSector = u32(bytes, 60);
  const firstDifatSector = u32(bytes, 68);
  const numDifatSectors = u32(bytes, 72);
  const sectorOffset = (s) => (s + 1) << sectorShift;

  // A compound file can hold at most (fileSize / sectorSize) sectors, so the FAT and DIFAT
  // can never legitimately exceed that. Bound EVERYTHING by it — the walk length, the difat
  // array, and the fat array — and detect a self-referencing DIFAT continuation pointer.
  // Without these, a forged numDifatSectors + a self-looping continuation inflates `fat` to
  // billions of entries (~2.6 GB) and OOM-kills the tab from one small upload.
  const maxSectors = Math.ceil(bytes.length / sectorSize) + 1;
  const difat = [];
  for (let i = 0; i < 109; i++) { const v = u32(bytes, 76 + i * 4); if (v <= 0xFFFFFFFA && difat.length < maxSectors) difat.push(v); }
  const seenDifat = new Set();
  let ds = firstDifatSector, guard = 0;
  while (ds !== ENDOFCHAIN && ds !== FREESECT && ds < maxSectors && guard++ < maxSectors) {
    if (seenDifat.has(ds)) break;                 // cycle detection — the load-bearing guard
    seenDifat.add(ds);
    const base = sectorOffset(ds); const per = sectorSize / 4;
    if (base + sectorSize > bytes.length) break;
    for (let i = 0; i < per - 1; i++) { const v = u32(bytes, base + i * 4); if (v <= 0xFFFFFFFA && difat.length < maxSectors) difat.push(v); }
    ds = u32(bytes, base + (per - 1) * 4);
  }
  const fat = [];
  outer: for (const fs of difat) { const base = sectorOffset(fs); if (base + sectorSize > bytes.length) continue; for (let i = 0; i < sectorSize / 4; i++) { if (fat.length >= maxSectors) break outer; fat.push(u32(bytes, base + i * 4)); } }

  function readChain(start) {
    const parts = []; let s = start, g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length && g++ < fat.length + 8) {
      const off = sectorOffset(s); parts.push(bytes.subarray(off, off + sectorSize)); s = fat[s];
    }
    return concatBytes(parts);
  }

  const dirBytes = readChain(firstDirSector);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const type = dirBytes[o + 66];
    if (type === 0) { entries.push(null); continue; }
    const nameLen = u16(dirBytes, o + 64);
    let name = '';
    for (let i = 0; i + 1 < nameLen && i < 64; i += 2) { const c = u16(dirBytes, o + i); if (c === 0) break; name += String.fromCharCode(c); }
    entries.push({ name, type, start: u32(dirBytes, o + 116), size: u32(dirBytes, o + 120), left: u32(dirBytes, o + 68), right: u32(dirBytes, o + 72), child: u32(dirBytes, o + 76) });
  }
  const root = entries.find((e) => e && e.type === 5);
  const miniStream = root ? readChain(root.start) : new Uint8Array(0);
  const mfBytes = readChain(firstMiniFatSector);
  const miniFat = []; for (let i = 0; i + 4 <= mfBytes.length; i += 4) miniFat.push(u32(mfBytes, i));

  function readMiniChain(start, size) {
    // A stream can't be larger than the mini stream that backs it; clamp the declared size
    // so a forged entry size can't request a multi-GB allocation (defense-in-depth).
    size = Math.min(size >>> 0, miniStream.length + miniSectorSize);
    const out = new Uint8Array(size); let s = start, pos = 0, g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && pos < size && g++ < miniFat.length + 8) {
      const off = s * miniSectorSize; const n = Math.min(miniSectorSize, size - pos);
      out.set(miniStream.subarray(off, off + n), pos); pos += n; s = miniFat[s];
    }
    return out;
  }
  function readEntry(e) {
    if (!e) return new Uint8Array(0);
    if (e.type !== 5 && e.size < miniCutoff) return readMiniChain(e.start, e.size);
    return readChain(e.start).subarray(0, e.size);
  }
  function siblings(rootIdx) {
    const out = []; const stack = [rootIdx]; const seen = new Set();
    while (stack.length) {
      const i = stack.pop();
      if (i === undefined || i === 0xFFFFFFFF || seen.has(i)) continue;
      seen.add(i); const e = entries[i]; if (!e) continue;
      out.push(e); stack.push(e.left, e.right);
    }
    return out;
  }
  function childrenOf(e) { return (!e || e.child === 0xFFFFFFFF) ? [] : siblings(e.child); }
  function findStorage(nm) { return entries.find((e) => e && e.type === 1 && e.name.toLowerCase() === nm.toLowerCase()); }
  return { entries, readEntry, childrenOf, findStorage };
}

// MS-OVBA 2.4.1.3 — decompress a CompressedContainer starting at `start` (the 0x01 byte).
function ovbaDecompress(buf, start) {
  if (buf[start] !== 0x01) throw new Error('bad compressed container signature');
  let pos = start + 1; const out = [];
  while (pos + 2 <= buf.length) {
    const header = u16(buf, pos); const chunkStart0 = pos; pos += 2;
    const size = (header & 0x0FFF) + 3;          // total chunk bytes incl 2-byte header
    const compressed = (header & 0x8000) !== 0;
    const chunkEnd = chunkStart0 + size;
    if (!compressed) {
      for (let i = pos; i < chunkEnd && i < buf.length; i++) out.push(buf[i]);
      pos = chunkEnd; continue;
    }
    const decompStart = out.length;
    while (pos < chunkEnd && pos < buf.length) {
      const flags = buf[pos++];
      for (let b = 0; b < 8 && pos < chunkEnd && pos < buf.length; b++) {
        if ((flags & (1 << b)) === 0) { out.push(buf[pos++]); continue; }
        const token = u16(buf, pos); pos += 2;
        const diff = out.length - decompStart;
        let bitCount = 0; while ((1 << bitCount) < diff) bitCount++;
        if (bitCount < 4) bitCount = 4;
        const lenMask = 0xFFFF >> bitCount;
        const len = (token & lenMask) + 3;
        const offset = (token >> (16 - bitCount)) + 1;
        let src = out.length - offset;
        for (let k = 0; k < len; k++) out.push(out[src++]);
        if (out.length > MAX_VBA_BYTES) return Uint8Array.from(out);
      }
    }
    pos = chunkEnd;
  }
  return Uint8Array.from(out);
}

// Parse the (decompressed) `dir` stream from PROJECTMODULES onward. We scan straight to the
// PROJECTMODULES marker, skipping the PROJECTREFERENCES section (whose records have irregular
// framing) entirely — within the module section the framing is regular and easy to walk.
function parseDirModules(d) {
  const g16 = (o) => d[o] | (d[o + 1] << 8);
  const g32 = (o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  const latin1 = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < d.length; i++) s += String.fromCharCode(d[o + i]); return s; };
  const utf16 = (o, n) => { let s = ''; for (let i = 0; i + 1 < n && o + i + 1 < d.length; i += 2) s += String.fromCharCode(d[o + i] | (d[o + i + 1] << 8)); return s; };
  // Locate PROJECTMODULES robustly: require the canonical PROJECTMODULES(0F00,size2,count) +
  // PROJECTCOOKIE(1300,size2,cookie) adjacency, AND that the record after the cookie is a
  // MODULENAME(0019) or the terminator(0010). An attacker can plant a lone "0F 00 02 00 00 00"
  // inside PROJECTNAME data, but cannot easily fake this whole valid module-section header.
  let pos = -1, declaredCount = 0;
  for (let i = 0; i + 18 <= d.length; i++) {
    if (d[i] === 0x0F && d[i + 1] === 0x00 && d[i + 2] === 0x02 && d[i + 3] === 0x00 && d[i + 4] === 0x00 && d[i + 5] === 0x00
      && d[i + 8] === 0x13 && d[i + 9] === 0x00 && d[i + 10] === 0x02 && d[i + 11] === 0x00 && d[i + 12] === 0x00 && d[i + 13] === 0x00) {
      const after = i + 16;                        // skip PROJECTMODULES(8) + PROJECTCOOKIE(8)
      const nextId = g16(after);
      if (nextId === 0x0019 || nextId === 0x0010) { pos = after; declaredCount = g16(i + 6); break; }
    }
  }
  if (pos < 0) return { count: 0, modules: [] };
  const modules = []; let cur = null; let safety = 0;
  while (pos + 6 <= d.length && safety++ < 100000) {
    const id = g16(pos); const size = g32(pos + 2); pos += 6;
    if (id === 0x0010) break;                      // dir terminator
    switch (id) {
      case 0x0019: cur = { name: latin1(pos, size), streamName: '', textOffset: 0, type: 'bas' }; modules.push(cur); pos += size; break;
      case 0x0047: if (cur) cur.name = utf16(pos, size); pos += size; break;
      case 0x001A: {                               // MODULESTREAMNAME (MBCS + reserved + unicode)
        const mbcs = latin1(pos, size); pos += size;
        pos += 2; const su = g32(pos); pos += 4;
        const uni = utf16(pos, su); pos += su;
        if (cur) cur.streamName = uni || mbcs; break;
      }
      case 0x001C: { pos += size; pos += 2; const su = g32(pos); pos += 4; pos += su; break; } // MODULEDOCSTRING
      case 0x0031: if (cur) cur.textOffset = g32(pos); pos += size; break;                       // MODULEOFFSET
      case 0x0021: if (cur) cur.type = 'bas'; pos += size; break;                                // procedural
      case 0x0022: if (cur) cur.type = 'cls'; pos += size; break;                                // document/class
      default: pos += size;
    }
  }
  return { count: declaredCount, modules };
}

// Does decompressed text look like real VBA source (vs. garbage from a wrong text offset)?
// Every Excel module begins with `Attribute VB_Name = "…"`; correct decompression always
// contains it (or at least a Sub/Function/Property/Dim keyword), wrong offsets do not.
function looksLikeVba(s) {
  return !!s && (/Attribute\s+VB_/i.test(s) || /\b(Sub|Function|Property|Dim|Declare|Type|Enum)\b/.test(s));
}

function decodeText(bytes) {
  try { return new TextDecoder('windows-1252').decode(bytes); }
  catch { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
}

// Extract every VBA module's source from a vbaProject.bin (or an .xls workbook that
// embeds one). Returns [{ name, type, source }]. `found` reports whether a VBA project
// was present at all (so callers can flag "macros present but unreadable").
export function extractVbaModules(bytes) {
  let cfb;
  try { cfb = parseCfb(bytes); } catch { return { found: false, modules: [] }; }
  const vba = cfb.findStorage('VBA');
  if (!vba) return { found: false, modules: [] };
  const childMap = {};
  for (const c of cfb.childrenOf(vba)) if (c.type === 2) childMap[c.name.toLowerCase()] = c;
  const dirEntry = childMap['dir'];
  if (!dirEntry) return { found: true, modules: [], incomplete: true };
  let declaredCount = 0; let modules = [];
  try { const dir = parseDirModules(ovbaDecompress(cfb.readEntry(dirEntry), 0)); declaredCount = dir.count; modules = dir.modules; } catch { /* fall through */ }
  const out = [];
  const skip = new Set(['dir', '_vba_project', 'project', 'projectwm', '_srp_0', '_srp_1', '_srp_2', '_srp_3']);
  const claimed = new Set();
  for (const m of modules) {
    const key = (m.streamName || m.name || '').toLowerCase();
    const e = childMap[key] || childMap[(m.name || '').toLowerCase()];
    if (!e) continue;
    try {
      const src = decodeText(ovbaDecompress(cfb.readEntry(e), m.textOffset || 0));
      if (looksLikeVba(src)) { out.push({ name: m.name || e.name, type: m.type || 'bas', source: src }); claimed.add(e.name.toLowerCase()); }
    } catch { /* wrong offset / unreadable — leave for the fallback, count as incomplete below */ }
  }
  // Fallback: any leftover stream that isn't bookkeeping — scan candidate 0x01 container
  // starts (not just the first) until one decompresses to real VBA source. Recovers modules
  // a stomped / mis-offset dir stream couldn't place.
  const candidateStreams = Object.keys(childMap).filter((lc) => !skip.has(lc) && !lc.startsWith('__srp'));
  for (const lc of candidateStreams) {
    if (claimed.has(lc)) continue;
    const e = childMap[lc]; let recovered = false;
    try {
      const raw = cfb.readEntry(e);
      for (let at = 0, tries = 0; at >= 0 && at < raw.length && tries < 64; at = raw.indexOf(1, at + 1), tries++) {
        if (raw[at] !== 1) break;
        let src; try { src = decodeText(ovbaDecompress(raw, at)); } catch { continue; }
        if (looksLikeVba(src)) { out.push({ name: e.name, type: 'bas', source: src }); claimed.add(lc); recovered = true; break; }
      }
    } catch { /* ignore */ }
    void recovered;
  }
  // Safety net: if the dir DECLARED more modules than we recovered, or it declared modules
  // but we got none, the project is only partially readable — never silently under-report.
  const incomplete = (declaredCount > 0 && out.length < declaredCount)
    || (declaredCount === 0 && out.length === 0 && candidateStreams.length > 0);
  return { found: true, modules: out, incomplete };
}

// ===========================================================================
//  OOXML extraction (formulas, connections, defined names, Power Query, links)
//  Regex-based so it runs in Node tests without a DOM. The extracted text is then
//  handed to the same regex scanner, so light XML parsing is sufficient.
// ===========================================================================
function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x?[0-9a-fA-F]+;/g, ' ').replace(/&amp;/g, '&');
}
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
  return m ? unescapeXml(m[1]) : '';
}

// Pull cell formulas out of a worksheet (or macrosheet) part. Captures the master text of
// shared/array formulas; shared followers are skipped (they reference the master).
export function extractFormulas(sheetXml) {
  const out = [];
  // Cap the input and BOUND every attribute run ([^>]{0,N} not [^>]*): a worksheet part with
  // many unterminated `<c` openers (no closing `>`) made the twin unbounded [^>]* runs backtrack
  // quadratically. Real cell tags are short, so the bound is harmless. (ReDoS hardening.)
  const xml = String(sheetXml || '').slice(0, MAX_TEXT_BYTES);
  if (xml.indexOf('<f') < 0) return out;
  // Match a COMPLETE <c …>…</c> with single bounded classes — one class up to the closing
  // `>`, then pull `r=` and `<f>` from the captured pieces separately. Two nested [^>] runs
  // around a required attr backtrack quadratically on unterminated openers; one class doesn't.
  const re = /<c\b([^>]{0,400})>([\s\S]{0,8192}?)<\/c>/g;
  let m; let n = 0;
  while ((m = re.exec(xml)) && n < MAX_FORMULAS_PER_SHEET) {
    const rm = /\br="([A-Za-z]+[0-9]+)"/.exec(m[1]);
    if (!rm) continue;
    const fm = /<f\b[^>]{0,400}>([\s\S]{0,8192}?)<\/f>/.exec(m[2]);
    if (fm && fm[1].trim()) { out.push({ ref: rm[1], formula: unescapeXml(fm[1]) }); n++; }
  }
  return out;
}

// Sheet display names + defined names + workbook-level external markers, as scannable text.
export function parseWorkbookStructure(workbookXml) {
  const xml = String(workbookXml || '').slice(0, MAX_TEXT_BYTES);   // cap input (ReDoS hardening)
  const sheets = [];
  const sre = /<sheet\b[^>]{0,2048}>/g; let m; let guard = 0;
  while ((m = sre.exec(xml)) && guard++ < 10000) { const nm = attr(m[0], 'name'); if (nm) sheets.push(nm); }
  const names = [];
  // Bound the attribute run AND the body, and cap iterations: many unterminated <definedName>
  // openers otherwise rescanned to EOF each time (quadratic).
  const dre = /<definedName\b([^>]{0,2048})>([\s\S]{0,8192}?)<\/definedName>/g; guard = 0;
  while ((m = dre.exec(xml)) && guard++ < 10000) names.push({ name: attr('<x ' + m[1] + '>', 'name'), value: unescapeXml(m[2]) });
  return { sheets, names };
}

// Best-effort Power Query (M) extraction from the DataMashup blob (base64 in a customXml
// part). The decoded blob embeds a zip ("Package Parts") whose Formulas/Section1.m holds
// the M. Falls back to scanning the decoded bytes for M text when the zip can't be read.
export async function extractPowerQueryM(dataMashupBase64, JSZipRef) {
  try {
    const bin = base64ToBytes(dataMashupBase64);
    let pk = -1;
    for (let i = 0; i + 4 < bin.length; i++) { if (bin[i] === 0x50 && bin[i + 1] === 0x4B && bin[i + 2] === 0x03 && bin[i + 3] === 0x04) { pk = i; break; } }
    if (pk >= 0 && JSZipRef) {
      const inner = await JSZipRef.loadAsync(bin.subarray(pk));
      const out = [];
      for (const name of Object.keys(inner.files)) {
        if (/\.m$/i.test(name) || /section\d*\.m/i.test(name) || /formulas\//i.test(name)) {
          const t = await inner.files[name].async('string');
          if (t && t.trim()) out.push({ name: name.split('/').pop(), code: t });
        }
      }
      if (out.length) return out;
    }
    // fallback: readable text scan
    const txt = decodeText(bin);
    const sec = /section\s+[\s\S]*/i.exec(txt);
    if (sec) return [{ name: 'Section1.m', code: sec[0].slice(0, MAX_TEXT_BYTES) }];
  } catch { /* ignore */ }
  return [];
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

// ===========================================================================
//  CSV / TSV — mostly DATA, not a tool. We surface formula/DDE-injection cells (the only
//  real "tool/risk" a flat file can carry) as a runtime artifact, and keep the raw rows as
//  data so the restricted-data keyword scan still runs over them.
// ===========================================================================
export function csvToArtifacts(text, name) {
  const files = [];
  const s = String(text || '');
  const raw = s.slice(0, MAX_TEXT_BYTES);
  files.push({ path: `data/${name}`, text: raw, bytes: raw.length, truncated: s.length > MAX_TEXT_BYTES });
  // Delimiter: trust the extension; otherwise count tabs vs commas OUTSIDE quoted fields
  // (so prose commas inside a quoted note don't masquerade as a comma-delimited file).
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  let delim;
  if (ext === 'tsv') delim = '\t';
  else if (ext === 'csv') delim = ',';
  else { const unq = raw.replace(/"(?:[^"]|"")*"/g, ''); delim = (unq.match(/\t/g) || []).length > (unq.match(/,/g) || []).length ? '\t' : ','; }
  // A cell that begins with = + - @ is interpreted as a formula by Excel on open — the
  // classic CSV/DDE-injection vector. Parse as proper records (quote state carries across
  // physical newlines, so an embedded newline in a quoted field can't hide an injection).
  const inject = [];
  for (const { row, col, value } of parseCsvRecords(raw, delim)) {
    const v = value.replace(/^\s+/, '');                       // trim leading WS only (quotes already consumed)
    if (/^[=+\-@]/.test(v) && /[A-Za-z(]/.test(v)) inject.push(`${cellRef(col, row)}: ${v.slice(0, 200)}`);
    if (inject.length >= 500) break;
  }
  if (inject.length) {
    const t = `Formula/DDE-injection cells found in ${name}:\n` + inject.join('\n');
    files.push({ path: `formulas/${safeName(name)}.injection.formulas`, text: t, bytes: t.length, truncated: false });
  }
  return files;
}
// Record-aware CSV/TSV parser: quote state carries across physical newlines (RFC-4180-ish).
// Yields { row, col, value } for the first `maxCells` non-empty cells.
function parseCsvRecords(text, delim, maxCells = Infinity) {
  const out = []; let row = 0, col = 0, cur = '', q = false, started = false;
  const push = () => { if (cur !== '' || started) out.push({ row, col, value: cur }); cur = ''; col++; started = false; };
  for (let i = 0; i < text.length && out.length < maxCells; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; started = true; continue; }
    if (ch === '"') { q = true; started = true; }
    else if (ch === delim) push();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; push(); row++; col = 0; }
    else { cur += ch; started = true; }
  }
  if (cur !== '' || started) out.push({ row, col, value: cur });
  return out;
}
function cellRef(col, row) {
  let s = ''; let c = col;
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return s + (row + 1);
}

// ===========================================================================
//  Orchestration
// ===========================================================================
function getZipLib(opts) {
  const z = (opts && opts.JSZip) || (typeof JSZip !== 'undefined' ? JSZip : (typeof globalThis !== 'undefined' ? globalThis.JSZip : undefined));
  if (!z) throw new Error('Spreadsheet support is unavailable (JSZip failed to load).');
  return z;
}

const fmtExt = (p) => (p.split('.').pop() || '').toLowerCase();
export function isSpreadsheet(name) {
  return /\.(xlsx|xlsm|xlsb|xltx|xltm|xls|csv|tsv)$/i.test(name || '');
}

export async function loadFromSpreadsheet(file, onProgress = () => {}, opts = {}) {
  const name = file.name || opts.name || 'workbook';
  const ext = fmtExt(name);
  if (ext === 'csv' || ext === 'tsv') {
    onProgress('Reading data file…');
    const text = await readBlobText(file);
    const files = csvToArtifacts(text, name);
    return normalize(files, { source: 'spreadsheet', label: name, meta: { kind: ext }, notes: noteFor(files, ext) });
  }
  if (ext === 'xls') {
    onProgress('Reading legacy workbook…');
    const bytes = await readBlobBytes(file);
    const files = []; const notes = [];
    const vba = extractVbaModules(bytes);
    pushVba(files, vba, notes);
    if (!files.length) notes.push('This is a legacy .xls workbook — cell formulas are stored in a binary format Lane can’t read; only its macros were analyzed.');
    return normalize(files, { source: 'spreadsheet', label: name, meta: { kind: 'xls' }, notes });
  }
  // OOXML workbook (xlsx/xlsm/xlsb/xltx/xltm)
  onProgress('Unpacking workbook…');
  const ZipLib = getZipLib(opts);
  let zip;
  try { zip = await ZipLib.loadAsync(file); }
  catch {
    return normalize(
      [{ path: 'data/summary.txt', text: '(This file could not be read as a workbook — it may be corrupt or truncated.)', bytes: 0, truncated: false }],
      { source: 'spreadsheet', label: name, meta: { kind: ext }, notes: ['This workbook could not be opened (corrupt or truncated archive).'] },
    );
  }
  const entries = zip.files;
  const has = (p) => !!entries[p];
  const readStr = async (p) => (entries[p] ? entries[p].async('string') : '');
  const readBin = async (p) => (entries[p] ? entries[p].async('uint8array') : null);
  const files = []; const notes = [];
  let total = 0;
  const add = (path, text) => {
    if (total >= MAX_TOTAL_BYTES || !text) return;
    let t = text; let truncated = false;
    if (t.length > MAX_TEXT_BYTES) { t = t.slice(0, MAX_TEXT_BYTES); truncated = true; }
    total += t.length;
    files.push({ path, text: t, bytes: t.length, truncated });
  };

  // Resolve a workbook part by its relationship Type rather than a hardcoded path — a
  // macro/connection part can be relocated (e.g. xl/macros/custom.bin) with the .rels
  // Target rewritten, which Excel still loads; hardcoding the path would miss it.
  const wbRelsXml = await readStr('xl/_rels/workbook.xml.rels');
  const relTarget = (typeSuffix) => {
    let m; const rre = /<Relationship\b[^>]*>/g;
    while ((m = rre.exec(wbRelsXml))) {
      const type = attr(m[0], 'Type'); const tgt = attr(m[0], 'Target');
      if (type && tgt && new RegExp(typeSuffix.replace(/[/]/g, '\\/') + '$', 'i').test(type)) return 'xl/' + tgt.replace(/^\//, '').replace(/^xl\//, '');
    }
    return null;
  };

  // --- VBA macros ---
  onProgress('Reading macros…');
  const vbaBin = await readBin(relTarget('/vbaProject') || 'xl/vbaProject.bin');
  if (vbaBin) {
    const vba = extractVbaModules(vbaBin);
    for (const m of vba.modules) add(`vba/${safeName(m.name)}.${m.type === 'cls' ? 'cls' : 'bas'}`, m.source);
    // No modules read, OR fewer than the project declared (stomped/protected/corrupt): never
    // silently under-report — emit the sentinel so the verdict defaults cautiously to Lane 2.
    if (!vba.modules.length || vba.incomplete) {
      add('vba/_unreadable.bas', "' A VBA macro project is present but could not be fully read.\nVBA_PROJECT_PRESENT_UNREADABLE");
      notes.push(vba.modules.length
        ? 'This workbook contains more macro code than could be fully read — treated cautiously.'
        : 'This workbook contains macros, but their code could not be read (it may be password-protected or corrupt). Treated cautiously.');
    }
  }

  // --- formulas (worksheets + macro/Excel-4 sheets) ---
  onProgress('Reading formulas…');
  const isXlsb = ext === 'xlsb';
  const wbStruct = parseWorkbookStructure(await readStr('xl/workbook.xml'));
  const sheetNameByFile = await mapSheetNames(readStr);
  for (const path of Object.keys(entries)) {
    const mm = /^xl\/(worksheets|macrosheets)\/([^/]+)\.xml$/i.exec(path);
    if (!mm) continue;
    const isMacro = /macrosheet/i.test(mm[1]);
    const xml = await readStr(path);
    const formulas = extractFormulas(xml);
    if (!formulas.length) continue;
    const label = sheetNameByFile[path] || mm[2];
    const body = formulas.map((f) => `${f.ref}: ${f.formula}`).join('\n');
    add(`${isMacro ? 'macrosheets' : 'formulas'}/${safeName(label)}.${isMacro ? 'xlm' : 'formulas'}`, body);
  }
  if (isXlsb && !files.some((f) => f.path.startsWith('formulas/'))) notes.push('This is a binary .xlsb workbook — cell formulas are stored in a binary format Lane can’t fully read; macros and connections were still analyzed.');

  // --- external data connections + query tables ---
  onProgress('Reading data connections…');
  const connPath = relTarget('/connections');
  if (connPath && has(connPath)) add('connections/connections.xml', await readStr(connPath));
  else if (has('xl/connections.xml')) add('connections/connections.xml', await readStr('xl/connections.xml'));
  for (const path of Object.keys(entries)) {
    if (/^xl\/queryTables\/[^/]+\.xml$/i.test(path)) add(`connections/${path.split('/').pop()}`, await readStr(path));
  }

  // --- external workbook links (other workbooks / network shares) ---
  const links = [];
  for (const path of Object.keys(entries)) {
    if (/^xl\/externalLinks\/_rels\/[^/]+\.rels$/i.test(path)) {
      const rel = await readStr(path);
      const tre = /Target\s*=\s*"([^"]*)"/gi; let r;
      while ((r = tre.exec(rel))) links.push(unescapeXml(r[1]));
    }
  }
  if (links.length) add('links/external-links.xllinks', 'External workbook references:\n' + links.map((l) => `=> ${l}`).join('\n'));

  // --- Power Query (M) ---
  onProgress('Reading queries…');
  for (const path of Object.keys(entries)) {
    if (!/customxml\/item\d*\.xml$/i.test(path) && !/datamashup/i.test(path)) continue;
    const xml = await readStr(path);
    const dm = /<DataMashup[^>]*>([\s\S]*?)<\/DataMashup>/i.exec(xml) || (/datamashup/i.test(path) ? [null, xml] : null);
    if (!dm) continue;
    const queries = await extractPowerQueryM(dm[1], ZipLib);
    for (const q of queries) { const nm = safeName(q.name || 'Query').replace(/\.m$/i, ''); add(`powerquery/${nm}.m`, q.code); }
  }

  // --- workbook structure (sheet + defined names) ---
  const struct = [];
  if (wbStruct.sheets.length) struct.push('Sheets: ' + wbStruct.sheets.join(', '));
  for (const n of wbStruct.names) struct.push(`Name ${n.name}: ${n.value}`);
  if (struct.length) add('names/workbook-structure.defnames', struct.join('\n'));

  // --- app metadata (informational) ---
  const appXml = await readStr('docProps/app.xml');
  const application = /<Application>([^<]*)<\/Application>/i.exec(appXml);

  if (!files.length) {
    add('data/summary.txt', '(No macros, formulas, connections, or queries were found in this workbook.)');
    notes.push('No tools (macros, live formulas, connections, or queries) were found — this looks like plain data.');
  }
  return normalize(files, {
    source: 'spreadsheet', label: name,
    meta: { kind: ext, application: application ? application[1] : '', sheets: wbStruct.sheets },
    notes,
  });
}

async function mapSheetNames(readStr) {
  const map = {};
  try {
    const wb = await readStr('xl/workbook.xml');
    const rels = await readStr('xl/_rels/workbook.xml.rels');
    const ridToTarget = {};
    let m; const rre = /<Relationship\b[^>]*>/g;
    while ((m = rre.exec(rels))) { const id = attr(m[0], 'Id'); const tgt = attr(m[0], 'Target'); if (id && tgt) ridToTarget[id] = tgt.replace(/^\//, '').replace(/^xl\//, ''); }
    const sre = /<sheet\b[^>]*>/g;
    while ((m = sre.exec(wb))) {
      const nm = attr(m[0], 'name'); const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
      const tgt = ridToTarget[rid];
      if (nm && tgt) map['xl/' + tgt.replace(/^xl\//, '')] = nm;
    }
  } catch { /* fall back to file names */ }
  return map;
}

function pushVba(files, vba, notes) {
  for (const m of vba.modules) files.push(mkFile(`vba/${safeName(m.name)}.${m.type === 'cls' ? 'cls' : 'bas'}`, m.source));
  if (vba.found && (!vba.modules.length || vba.incomplete)) {
    files.push(mkFile('vba/_unreadable.bas', "' A VBA macro project is present but could not be fully read.\nVBA_PROJECT_PRESENT_UNREADABLE"));
    notes.push('This workbook contains macros, but their code could not be fully read. Treated cautiously.');
  }
}
function mkFile(path, text) { const t = (text || '').slice(0, MAX_TEXT_BYTES); return { path, text: t, bytes: t.length, truncated: (text || '').length > MAX_TEXT_BYTES }; }
function safeName(s) { return String(s || 'item').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 64) || 'item'; }
function noteFor(files, ext) {
  const notes = [];
  if (files.some((f) => f.path.startsWith('formulas/'))) notes.push('This file contains cells that Excel would run as formulas on open (a CSV/DDE-injection risk).');
  else notes.push('This looks like a plain data file — no embedded tool was found.');
  return notes;
}
function normalize(files, partial) { return { files, ...partial }; }

async function readBlobText(file) {
  if (typeof file === 'string') return file;
  if (file && typeof file.text === 'function') return file.text();
  if (file instanceof Uint8Array) return decodeText(file);
  return String(file);
}
async function readBlobBytes(file) {
  if (file instanceof Uint8Array) return file;
  if (file && typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(0);
}
