#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> Fix index.mjs wiring for getContractsV1 (force top-level export at EOF)"

python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()
out=[]
for ln in s.splitlines(True):
  t=ln.strip()
  if t == 'import { handleGetContractsV1 } from "./getContractsV1.mjs";':
    continue
  if t.startswith("export const getContractsV1"):
    continue
  if t == 'export { getContractsV1 } from "./getContractsV1.mjs";':
    continue
  if t == 'import { getContractsV1 } from "./getContractsV1.mjs";':
    continue
  out.append(ln)
s="".join(out)
imp='import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
if imp not in s:
  lines=s.splitlines(True)
  inserted=False
  out=[]
  for i,ln in enumerate(lines):
    out.append(ln)
    if (not inserted) and ln.startswith("import "):
      # insert after first import line
      out.append(imp)
      inserted=True
      # don't keep inserting
      # but keep remaining lines
  s="".join(out)

export_line='\nexport const getContractsV1 = onRequest(handleGetContractsV1);\n'
if "export const getContractsV1" not in s:
  if not s.endswith("\n"):
    s += "\n"
  s += export_line

p.write_text(s)
print("✅ rewrote functions_clean/index.mjs (import ensured, export appended at EOF)")
PY

echo "==> Show the tail (sanity)"
tail -n 15 functions_clean/index.mjs | sed -n '1,15p'

echo "==> Hard syntax check by actually importing (this catches block-scope exports too)"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ IMPORT_OK')).catch(e=>{console.error('❌ IMPORT_FAIL'); console.error(e); process.exit(1);})"

echo "==> Deploy"
firebase deploy --only functions:getContractsV1
echo "✅ deployed getContractsV1"
