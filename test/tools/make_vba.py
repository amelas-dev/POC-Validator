"""Minimal CFB (OLE2) + vbaProject.bin + .xlsm writer for building olevba-validated test
fixtures with arbitrary VBA. Streams are all small -> stored in the mini stream."""
import struct, zipfile, io, os

# ---------- MS-OVBA compression (validated against olevba) ----------
def _compress_chunk(data):
    out = bytearray(); pos = 0; n = len(data)
    while pos < n:
        fp = len(out); out.append(0); flags = 0
        for bit in range(8):
            if pos >= n: break
            diff = pos
            bc = max((diff - 1).bit_length() if diff >= 1 else 0, 4)
            lm = 0xFFFF >> bc; maxlen = lm + 3; maxoff = 1 << bc
            start = max(0, pos - maxoff); bl = 0; bo = 0; cand = pos - 1
            while cand >= start:
                l = 0
                while l < maxlen and pos + l < n and data[cand + l] == data[pos + l]: l += 1
                if l > bl:
                    bl = l; bo = pos - cand
                    if l == maxlen: break
                cand -= 1
            if bl >= 3:
                out += struct.pack('<H', ((bo - 1) << (16 - bc)) | (bl - 3)); flags |= (1 << bit); pos += bl
            else:
                out.append(data[pos]); pos += 1
        out[fp] = flags
    return bytes(out)

def ovba_compress(src: bytes) -> bytes:
    out = bytearray([0x01]); pos = 0; n = len(src)
    while pos < n:
        chunk = src[pos:pos + 4096]; pos += len(chunk); full = len(chunk) == 4096
        comp = _compress_chunk(chunk)
        if (not full) or (len(comp) < len(chunk)):
            assert len(comp) <= 4096
            out += struct.pack('<H', 0x8000 | 0x3000 | (len(comp) - 1)); out += comp
        else:
            out += struct.pack('<H', 0x3FFF); out += chunk
    return bytes(out)

# ---------- dir + PROJECT streams ----------
def _rec(idval, data): return struct.pack('<HI', idval, len(data)) + data
def _mbcs(s): return s.encode('latin-1', 'replace')
def _utf16(s): return s.encode('utf-16-le')

def build_dir(project_name, modules):
    # modules: list of dicts {name, stream, type('bas'|'cls'), text_offset}
    b = bytearray()
    b += _rec(0x0001, struct.pack('<I', 1))          # SYSKIND win32
    b += _rec(0x0002, struct.pack('<I', 0x409))      # LCID
    b += _rec(0x0014, struct.pack('<I', 0x409))      # LCIDINVOKE
    b += _rec(0x0003, struct.pack('<H', 1252))       # CODEPAGE
    b += _rec(0x0004, _mbcs(project_name))           # PROJECTNAME
    # PROJECTDOCSTRING (dual, both empty)
    b += struct.pack('<HI', 0x0005, 0) + struct.pack('<HI', 0x0040, 0)
    # PROJECTHELPFILEPATH (dual, empty)
    b += struct.pack('<HI', 0x0006, 0) + struct.pack('<HI', 0x003D, 0)
    b += _rec(0x0007, struct.pack('<I', 0))          # HELPCONTEXT
    b += _rec(0x0008, struct.pack('<I', 0))          # LIBFLAGS
    # PROJECTVERSION: Id, Reserved=4, Major(4), Minor(2)
    b += struct.pack('<HI', 0x0009, 4) + struct.pack('<IH', 1, 0)
    # PROJECTCONSTANTS (dual, empty)
    b += struct.pack('<HI', 0x000C, 0) + struct.pack('<HI', 0x003C, 0)
    # No references.
    # PROJECTMODULES
    b += _rec(0x000F, struct.pack('<H', len(modules)))
    b += _rec(0x0013, struct.pack('<H', 0xFFFF))     # PROJECTCOOKIE
    for m in modules:
        b += _rec(0x0019, _mbcs(m['name']))          # MODULENAME
        b += _rec(0x0047, _utf16(m['name']))         # MODULENAMEUNICODE
        # MODULESTREAMNAME (dual)
        sn = _mbcs(m['stream']); snu = _utf16(m['stream'])
        b += struct.pack('<HI', 0x001A, len(sn)) + sn + struct.pack('<HI', 0x0032, len(snu)) + snu
        # MODULEDOCSTRING (dual empty)
        b += struct.pack('<HI', 0x001C, 0) + struct.pack('<HI', 0x0048, 0)
        b += _rec(0x0031, struct.pack('<I', m['text_offset']))   # MODULEOFFSET
        b += _rec(0x001E, struct.pack('<I', 0))                  # HELPCONTEXT
        b += _rec(0x002C, struct.pack('<H', 0xFFFF))            # MODULECOOKIE
        b += _rec(0x0021 if m['type'] == 'bas' else 0x0022, b'')  # MODULETYPE
        b += _rec(0x002B, b'')                                   # module terminator
    b += _rec(0x0010, b'')                            # dir terminator
    return ovba_compress(bytes(b))

def build_project_stream(modules):
    lines = ['ID="{00000000-0000-0000-0000-000000000000}"']
    for m in modules:
        if m['type'] == 'cls':
            lines.append(f"Document={m['name']}/&H00000000")
        else:
            lines.append(f"Module={m['name']}")
    lines += ['', '[Host Extender Info]', '&H00000001={3832D640-CF90-11CF-8E43-00A0C911005A};VBE;&H00000000', '']
    return ('\r\n'.join(lines)).encode('latin-1', 'replace')

# ---------- CFB writer (all streams in mini stream) ----------
FREESECT = 0xFFFFFFFF; ENDOFCHAIN = 0xFFFFFFFE; FATSECT = 0xFFFFFFFD

def build_cfb(streams, storages):
    """streams: list of (path, data) where path like 'PROJECT' or 'VBA/dir'.
       storages: list of storage names like ['VBA'].
       Returns CFB bytes. All streams stored in mini stream (assume <4096 each)."""
    SECT = 512; MINI = 64
    # Build directory entries. Index 0 = Root. Then storages, then streams.
    # We must assemble children trees per parent.
    entries = []  # each: dict name,type,start,size,left,right,child,color
    def add(name, etype):
        entries.append({'name': name, 'type': etype, 'start': ENDOFCHAIN, 'size': 0,
                        'left': FREESECT, 'right': FREESECT, 'child': FREESECT})
        return len(entries) - 1
    root = add('Root Entry', 5)
    name_to_idx = {}
    stor_idx = {}
    for s in storages:
        stor_idx[s] = add(s, 1)
    # mini stream assembly
    mini = bytearray(); minifat = []
    stream_meta = {}  # path -> (start_minisector, size)
    def put_mini(data):
        if len(data) == 0:
            return ENDOFCHAIN
        start = len(mini) // MINI
        nsect = (len(data) + MINI - 1) // MINI
        for i in range(nsect):
            mini.extend(data[i*MINI:(i+1)*MINI])
            pad = MINI - (len(data[i*MINI:(i+1)*MINI]))
            if pad and pad != MINI: mini.extend(b'\x00' * pad)
            minifat.append(start + i + 1 if i < nsect - 1 else ENDOFCHAIN)
        return start
    # create stream entries
    children = {None: [], }
    for s in storages: children[s] = []
    for path, data in streams:
        if '/' in path:
            parent, nm = path.split('/', 1)
        else:
            parent, nm = None, path
        idx = add(nm, 2)
        st = put_mini(bytes(data))
        entries[idx]['start'] = st
        entries[idx]['size'] = len(data)
        children.setdefault(parent, []).append(idx)
    # storages are children of root; also streams with parent None are children of root
    children.setdefault(None, [])
    for s in storages:
        children[None].append(stor_idx[s])
    # build sibling trees (sorted by (len,upper)), degenerate right-linked BST
    def cfb_key(i):
        n = entries[i]['name']; return (len(n), n.upper())
    def link(parent_idx, kids):
        if not kids: return FREESECT
        kids = sorted(kids, key=cfb_key)
        for j in range(len(kids) - 1):
            entries[kids[j]]['right'] = kids[j+1]
        return kids[0]
    entries[root]['child'] = link(root, children[None])
    for s in storages:
        entries[stor_idx[s]]['child'] = link(stor_idx[s], children.get(s, []))
    # Root holds the mini stream in regular sectors.
    mini_bytes = bytes(mini)
    # Layout regular sectors: [miniFAT sectors][mini stream sectors][directory sectors]
    def chunk(data, size):
        return [data[i:i+size] for i in range(0, len(data), size)] or [b'']
    # miniFAT: array of uint32
    minifat_bytes = b''.join(struct.pack('<I', v) for v in minifat)
    minifat_bytes = minifat_bytes + b'\xFF' * ((SECT - len(minifat_bytes) % SECT) % SECT) if minifat_bytes else b''
    # directory: 128 bytes/entry, padded to sector
    def dir_entry_bytes(e):
        nm = e['name'].encode('utf-16-le')[:62]
        nm = nm + b'\x00\x00'
        namebuf = nm + b'\x00' * (64 - len(nm))
        namelen = len(nm)
        return (namebuf + struct.pack('<H', namelen) + bytes([e['type'], 1]) +
                struct.pack('<III', e['left'], e['right'], e['child']) +
                b'\x00'*16 + struct.pack('<I', 0) + b'\x00'*16 +
                struct.pack('<I', e['start']) + struct.pack('<Q', e['size']))
    dir_bytes = b''.join(dir_entry_bytes(e) for e in entries)
    dir_bytes = dir_bytes + b'\x00' * ((SECT - len(dir_bytes) % SECT) % SECT)

    # assign sectors
    sectors = []
    minifat_sectors = chunk(minifat_bytes, SECT) if minifat_bytes else []
    ministream_sectors = chunk(mini_bytes, SECT) if mini_bytes else []
    dir_sectors = chunk(dir_bytes, SECT)
    # pad each to SECT
    def padsect(s): return s + b'\x00' * (SECT - len(s)) if len(s) < SECT else s

    first_minifat = 0 if minifat_sectors else ENDOFCHAIN
    n_minifat = len(minifat_sectors)
    first_ministream = n_minifat if ministream_sectors else ENDOFCHAIN
    n_ministream = len(ministream_sectors)
    first_dir = n_minifat + n_ministream
    n_dir = len(dir_sectors)
    total_data_sectors = n_minifat + n_ministream + n_dir
    # FAT
    fat = [FREESECT] * total_data_sectors
    def chainify(first, count):
        for i in range(count):
            fat[first + i] = (first + i + 1) if i < count - 1 else ENDOFCHAIN
    if n_minifat: chainify(first_minifat, n_minifat)
    if n_ministream: chainify(first_ministream, n_ministream)
    chainify(first_dir, n_dir)
    # root entry points at mini stream
    entries[root]['start'] = first_ministream if n_ministream else ENDOFCHAIN
    entries[root]['size'] = len(mini_bytes)
    # rebuild dir bytes now that root start/size set
    dir_bytes = b''.join(dir_entry_bytes(e) for e in entries)
    dir_bytes = dir_bytes + b'\x00' * ((SECT - len(dir_bytes) % SECT) % SECT)
    dir_sectors = chunk(dir_bytes, SECT)
    # FAT sectors: need to store `fat` plus the FAT sectors themselves
    # number of FAT entries that fit per sector = 128
    per = SECT // 4
    # iteratively size the FAT (FAT must describe data sectors + FAT sectors)
    n_fat = 1
    while True:
        total = total_data_sectors + n_fat
        need = (total + per - 1) // per
        if need == n_fat: break
        n_fat = need
    # FAT sectors are placed AFTER data sectors
    first_fat = total_data_sectors
    fat_full = fat + [FATSECT] * n_fat
    fat_full += [FREESECT] * (n_fat * per - len(fat_full))
    fat_bytes = b''.join(struct.pack('<I', v) for v in fat_full)
    fat_sectors = chunk(fat_bytes, SECT)

    # header
    header = bytearray(512)
    header[0:8] = bytes([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1])
    struct.pack_into('<H', header, 24, 0x003E)   # minor
    struct.pack_into('<H', header, 26, 0x0003)   # major v3
    struct.pack_into('<H', header, 28, 0xFFFE)   # byte order
    struct.pack_into('<H', header, 30, 9)        # sector shift 512
    struct.pack_into('<H', header, 32, 6)        # mini sector shift 64
    struct.pack_into('<I', header, 44, n_fat)    # num FAT sectors
    struct.pack_into('<I', header, 48, first_dir)
    struct.pack_into('<I', header, 56, 4096)     # mini cutoff
    struct.pack_into('<I', header, 60, first_minifat)
    struct.pack_into('<I', header, 64, n_minifat)
    struct.pack_into('<I', header, 68, ENDOFCHAIN)  # first DIFAT
    struct.pack_into('<I', header, 72, 0)           # num DIFAT
    # DIFAT array (first 109 fat sector locations)
    for i in range(109):
        loc = (first_fat + i) if i < n_fat else FREESECT
        struct.pack_into('<I', header, 76 + i*4, loc)

    out = bytearray(header)
    for s in minifat_sectors: out += padsect(s)
    for s in ministream_sectors: out += padsect(s)
    for s in dir_sectors: out += padsect(s)
    for s in fat_sectors: out += padsect(s)
    return bytes(out)

def build_vbaproject(project_name, modules_src):
    """modules_src: list of (name, type, source_text). Returns vbaProject.bin bytes."""
    modules = []
    streams = []
    for (name, mtype, src) in modules_src:
        comp = ovba_compress(src.encode('latin-1', 'replace'))
        modules.append({'name': name, 'stream': name, 'type': mtype, 'text_offset': 0})
        streams.append((f'VBA/{name}', comp))
    dirc = build_dir(project_name, modules)
    streams.append(('VBA/dir', dirc))
    streams.append(('VBA/_VBA_PROJECT', bytes([0x61, 0xCC, 0x00, 0x00, 0x00, 0x00])))
    streams.append(('PROJECT', build_project_stream(modules)))
    return build_cfb(streams, ['VBA'])

# ---------- .xlsm packaging ----------
def make_xlsm(path, project_name, modules_src, sheet_names=('Sheet1',), defined_names=None, extra_parts=None):
    vba = build_vbaproject(project_name, modules_src)
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-office.macroEnabled.main+xml"/>'
          + ''.join(f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(sheet_names)))
          + '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    sheets_xml = ''.join(f'<sheet name="{nm}" sheetId="{i+1}" r:id="rId{i+1}"/>' for i, nm in enumerate(sheet_names))
    dn = ''
    if defined_names:
        dn = '<definedNames>' + ''.join(f'<definedName name="{n}">{v}</definedName>' for n, v in defined_names) + '</definedNames>'
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<sheets>{sheets_xml}</sheets>{dn}</workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + ''.join(f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i+1}.xml"/>' for i in range(len(sheet_names)))
               + f'<Relationship Id="rId{len(sheet_names)+1}" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>'
               '</Relationships>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('xl/workbook.xml', workbook)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        for i, nm in enumerate(sheet_names):
            body = (extra_parts or {}).get(f'sheet{i+1}', '<sheetData/>')
            z.writestr(f'xl/worksheets/sheet{i+1}.xml',
                       '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                       '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       + body + '</worksheet>')
        z.writestr('xl/vbaProject.bin', vba)
        for pth, content in (extra_parts or {}).get('_files', {}).items():
            z.writestr(pth, content)
    return path

if __name__ == '__main__':
    src = ("Attribute VB_Name = \"Module1\"\r\n"
           "Sub RunShell()\r\n"
           "    Dim wsh As Object\r\n"
           "    Set wsh = CreateObject(\"WScript.Shell\")\r\n"
           "    wsh.Run \"cmd.exe /c dir\"\r\n"
           "End Sub\r\n")
    out = '/tmp/realxlsm/test_gen.xlsm'
    make_xlsm(out, 'TestProj', [('Module1', 'bas', src)])
    print('wrote', out)
    os.system(f'/tmp/lanevenv/bin/olevba "{out}" 2>/dev/null | sed -n "1,30p"')
