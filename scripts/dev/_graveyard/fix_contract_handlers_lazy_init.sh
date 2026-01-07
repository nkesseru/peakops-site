#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app
set +H 2>/dev/null || true
mkdir -p .logs

echo "==> (0) Files to patch"
FILES=(
  "functions_clean/getContractsV1.mjs"
  "functions_clean/getContractV1.mjs"
  "functions_clean/getContractPayloadsV1.mjs"
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "❌ missing $f"
    exit 1
  fi
done

echo "==> (1) Patch: remove top-level db init; add ensureAdmin() + get db inside handler"
python3 - <<'PY'
from pathlib import Path
import re

targets = [
  Path("functions_clean/getContractsV1.mjs"),
  Path("functions_clean/getContractV1.mjs"),
  Path("functions_clean/getContractPayloadsV1.mjs"),
]

ENSURE_BLOCK = r'''
function ensureAdmin() {
  try {
    if (!getApps().length) initializeApp();
  } catch (e) {}
}
'''.lstrip("\n")

for p in targets:
  s = p.read_text()

  # Ensure we have getApps/initializeApp imports (some files already do)
  if "getApps" not in s or "initializeApp" not in s:
    # If firebase-admin/app import exists, widen it; else add it
    if "from 'firebase-admin/app'" in s or 'from "firebase-admin/app"' in s:
      s = re.sub(r"import\s*\{\s*([^}]+)\s*\}\s*from\s*['\"]firebase-admin/app['\"];",
                 lambda m: f"import {{ {m.group(1).strip()}, initializeApp, getApps }} from 'firebase-admin/app';"
                           if "initializeApp" not in m.group(1) and "getApps" not in m.group(1) else m.group(0),
                 s, count=1)
    else:
      # Add import near top
      lines = s.splitlines()
      ins = 0
      for i,l in enumerate(lines):
        if l.startswith("import "):
          ins = i+1
      lines.insert(ins, "import { initializeApp, getApps } from 'firebase-admin/app';")
      s = "\n".join(lines)

  # Remove any top-level: if (!getApps().length) initializeApp(); and const db = getFirestore();
  s = re.sub(r"^\s*if\s*\(\s*!\s*getApps\(\)\.length\s*\)\s*initializeApp\([^)]*\);\s*$", "", s, flags=re.M)
  s = re.sub(r"^\s*if\s*\(\s*!\s*getApps\(\)\.length\s*\)\s*initializeApp\(\);\s*$", "", s, flags=re.M)
  s = re.sub(r"^\s*const\s+db\s*=\s*getFirestore\(\);\s*$", "", s, flags=re.M)

  # Add ensureAdmin() once (right after imports, before first function/export)
  if "function ensureAdmin()" not in s:
    lines = s.splitlines()
    last_import = 0
    for i,l in enumerate(lines):
      if l.startswith("import "):
        last_import = i
    lines.insert(last_import+1, "")
    lines.insert(last_import+2, ENSURE_BLOCK.rstrip("\n"))
    s = "\n".join(lines)

  # Inside exported handler, ensureAdmin(); const db = getFirestore();
  # Pattern: export const X = onRequest(async (req,res)=> {  -> inject after first "{"
  def inject(m):
    head = m.group(0)
    return head + "\n  ensureAdmin();\n  const db = getFirestore();\n"
  s2, n = re.subn(r"(export\s+const\s+\w+\s*=\s*onRequest\(\s*async\s*\([^)]*\)\s*=>\s*\{\s*)", inject, s, count=1)
  if n == 0:
    # Some files may be: export const X = onRequest((req,res)=> { ... })
    s2, n = re.subn(r"(export\s+const\s+\w+\s*=\s*onRequest\(\s*\([^)]*\)\s*=>\s*\{\s*)", inject, s, count=1)

  p.write_text(s2)

print("✅ patched handlers: lazy init + db in handler")
PY

echo "==> (2) Re-transpile into functions_emu/dist (cjs)"
mkdir -p functions_emu/dist
node - <<'NODE'
const { buildSync } = require("./functions_emu/node_modules/esbuild");
const path = require("path");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

const files = [
  ["getContractsV1.mjs", "getContractsV1.cjs"],
  ["getContractV1.mjs", "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs", "writeContractPayloadV1.cjs"],
];

for (const [src, out] of files) {
  buildSync({
    entryPoints: [path.join(SRC, src)],
    outfile: path.join(OUT, out),
    platform: "node",
    format: "cjs",
    bundle: true,
    sourcemap: false,
    logLevel: "silent",
  });
}
console.log("✅ transpiled:", files.map(x=>x[1]).join(", "));
NODE

echo "==> (3) Rewrite functions_emu/index.js (require dist/* inside handler wrappers)"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");

function ensureAdmin() {
  if (!getApps().length) initializeApp();
}

function wrap(modPath) {
  return onRequest(async (req, res) => {
    try {
      ensureAdmin();
      const fn = require(modPath);
      // support both module.exports = handler and exports.{name}=handler
      const handler =
        (typeof fn === "function" ? fn : null) ||
        fn.getContractsV1 ||
        fn.getContractV1 ||
        fn.getContractPayloadsV1 ||
        fn.writeContractPayloadV1;
      return handler(req, res);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1 = wrap("./dist/getContractsV1.cjs");
exports.getContractV1 = wrap("./dist/getContractV1.cjs");
exports.getContractPayloadsV1 = wrap("./dist/getContractPayloadsV1.cjs");
exports.writeContractPayloadV1 = wrap("./dist/writeContractPayloadV1.cjs");
JS
echo "✅ wrote functions_emu/index.js"

echo "==> (4) Restart emulators clean"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot --config firebase.emu.json > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 80); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
echo "✅ emulators hello OK (pid=$EMU_PID)"

echo "==> (5) Quick smoke (direct)"
curl -sS "$FN_BASE/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/getContractV1?orgId=org_001&contractId=car_abc123" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=org_001&contractId=car_abc123&limit=50" | python3 -m json.tool | head -n 40 || true
echo
echo "Logs: tail -n 120 .logs/emulators.log"
echo "Stop: kill $EMU_PID"
