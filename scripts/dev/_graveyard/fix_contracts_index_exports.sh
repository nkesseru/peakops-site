#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="functions_clean/index.mjs"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

echo "==> (1) Patch functions_clean/index.mjs exports"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# Remove any wrong/old contract exports (we'll re-add the correct ones)
bad_lines = [
  "export const getContractV1 = onRequest(getContractV1Handler);",
  "export const getContractV1 = onRequest(getContractV1);",
  "export const getContractsV1 = onRequest(getContractsV1);",
]
for bl in bad_lines:
  s = s.replace(bl + "\n", "")
  s = s.replace("\n" + bl, "")

# Ensure imports exist (add if missing)
need_imports = [
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n',
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n',
]
# Insert imports near the top after the first firebase-functions import (or at top)
if 'from "firebase-functions/v2/https"' in s:
  anchor = 'from "firebase-functions/v2/https";\n'
  idx = s.find(anchor)
  if idx != -1:
    insert_at = idx + len(anchor)
    block = ""
    for imp in need_imports:
      if imp.strip() not in s:
        block += imp
    if block:
      s = s[:insert_at] + block + s[insert_at:]
else:
  # fallback: just prepend
  block = "".join([imp for imp in need_imports if imp.strip() not in s])
  s = block + s

# Add correct exports right after hello export (stable anchor)
export_block = (
  "\n"
  "export const getContractsV1 = onRequest(handleGetContractsV1);\n"
  "export const getContractV1  = onRequest(handleGetContractV1);\n"
)

if "export const getContractsV1" not in s or "export const getContractV1" not in s:
  anchor = "export const hello = onRequest"
  a = s.find(anchor)
  if a == -1:
    raise SystemExit("❌ Could not find hello export to anchor after")
  end = s.find("};", a)
  if end == -1:
    raise SystemExit("❌ Could not find end of hello handler")
  end += 3
  s = s[:end] + export_block + s[end:]

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (2) ESM sanity: import index.mjs (instead of node --check)"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM import OK')).catch(e=>{console.error('❌ ESM import failed'); console.error(e); process.exit(1);})"

echo "==> (3) Deploy (optional)"
echo "Run one of:"
echo "  firebase deploy --only functions:getContractsV1,functions:getContractV1"
echo "  firebase deploy --only functions:getContractsV1"
echo "  firebase deploy --only functions:getContractV1"
