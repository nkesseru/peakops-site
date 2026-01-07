#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> Ensure functions_clean package.json is ESM + main=index.js"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
d = json.loads(p.read_text())
d["type"] = "module"
d["main"] = "index.js"
d.setdefault("engines", {})
d["engines"]["node"] = "20"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ package.json: type=module, main=index.js, engines.node=20")
PY

echo "==> Rename index.mjs -> index.js if needed"
if [[ -f functions_clean/index.mjs && ! -f functions_clean/index.js ]]; then
  mv functions_clean/index.mjs functions_clean/index.js
  echo "✅ moved functions_clean/index.mjs -> functions_clean/index.js"
fi

echo "==> Sanity check"
node --check functions_clean/index.js

echo "==> Done. Now deploy should analyze cleanly."
