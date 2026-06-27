# Spreadsheet test tooling (dev-only)

These scripts regenerate and independently validate the binary `.xlsm` fixtures used by
`test/spreadsheet.mjs`. They are **not** needed to run the test suite (the committed
base64 fixtures in `test/fixtures/` are self-contained) — they exist so the corpus can be
extended and the VBA extractor can be cross-checked against the industry-standard parser.

## Why this matters

`src/engine/spreadsheet.js` contains a from-scratch OLE2/CFB reader + MS-OVBA decompressor
that pulls VBA source out of `vbaProject.bin`. That binary code is the riskiest part of the
feature, so it is validated **byte-for-byte against [`olevba`](https://github.com/decalage2/oletools)**
(the de-facto standard, used across the security industry and matched to real Excel output).

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install oletools
```

## `make_vba.py` — build real, olevba-valid `.xlsm` fixtures

```python
import make_vba
make_vba.make_xlsm(
    "shell.xlsm", "MyProject",
    [("Module1", "bas", 'Attribute VB_Name = "Module1"\r\nSub R()\r\n  CreateObject("WScript.Shell").Run "cmd.exe /c dir"\r\nEnd Sub\r\n')],
    sheet_names=("Sheet1",),
)
```

It implements MS-OVBA compression and a minimal compound-file writer. Confirm any file it
produces is Excel-compatible by reading it back with the oracle:

```bash
olevba shell.xlsm          # should print the exact module source + flag Shell/WScript.Shell
```

## Cross-validating the JS extractor

The JS reader must match `olevba` on the same bytes. The pattern used during development:

1. `make_vba.make_xlsm(...)` → a real `.xlsm`.
2. `olevba file.xlsm` → oracle module source (independent of our code).
3. `extractVbaModules(vbaProjectBin)` from `src/engine/spreadsheet.js` → our source.
4. Assert (2) == (3).

To embed a new round-trip fixture in `test/spreadsheet.mjs`, base64 the workbook (or just
its `xl/vbaProject.bin`) into `test/fixtures/`.
