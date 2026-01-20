#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Put entry back to index.mjs"
if [[ -f functions_clean/index.js ]]; then
  mv -f functions_clean/index.js functions_clean/index.mjs
  echo "✅ moved functions_clean/index.js -> functions_clean/index.mjs"
fi

echo "==> (2) Force functions_clean package.json to ESM + main=index.mjs"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("functions_clean/package.json")
d = json.loads(p.read_text())
d["type"] = "module"
d["main"] = "index.mjs"
d.setdefault("engines", {})
d["engines"]["node"] = "20"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ package.json set: type=module, main=index.mjs, engines.node=20")
PY

echo "==> (3) Fix bad onRequest wiring (recursive call)"
# Replace ONLY the broken pattern if present
perl -0777 -i -pe 's/export const getContractV1\s*=\s*onRequest\(\s*getContractV1\s*\)\s*;/export const getContractV1 = onRequest(handleGetContractV1);/g' functions_clean/index.mjs || true
perl -0777 -i -pe 's/export const getContractsV1\s*=\s*onRequest\(\s*getContractsV1\s*\)\s*;/export const getContractsV1 = onRequest(handleGetContractsV1);/g' functions_clean/index.mjs || true

echo "==> (4) Verify handler names exist (shows lines)"
rg -n "handleGetContractV1|handleGetContractsV1|getContractV1 = onRequest|getContractsV1 = onRequest" functions_clean/index.mjs || true

echo "==> (5) Hard syntax check by importing as ESM"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ IMPORT_OK')).catch(e=>{console.error(e);process.exit(1)})"

echo "✅ functions_clean entry fixed."
