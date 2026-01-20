#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> (0) Ensure Node 20 via fnm"
if ! command -v fnm >/dev/null 2>&1; then
  brew install fnm
fi
eval "$(fnm env)"
fnm install 20 >/dev/null 2>&1 || true
fnm use 20
echo "✅ node=$(node -v)"

echo "==> (1) Load env"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"

echo "==> (2) Kill ports/procs"
pkill -f "firebase.*emulators" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
for p in 3000 5001 8081 4400; do
  lsof -tiTCP:$p -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done
mkdir -p .logs

echo "==> (3) Force functions_clean to ESM"
python3 - <<'PY'
from pathlib import Path
import json
p=Path("functions_clean/package.json")
d=json.loads(p.read_text()) if p.exists() else {}
d["name"]=d.get("name","functions-clean")
d["private"]=True
d["type"]="module"
d["main"]="index.mjs"
d.setdefault("engines",{})["node"]=d.get("engines",{}).get("node","20")
p.write_text(json.dumps(d, indent=2)+"\n")
print("✅ functions_clean/package.json -> type=module main=index.mjs")
PY

echo "==> (4) Restore clean functions_clean/index.mjs from tag (fallback: HEAD)"
if git show "refs/tags/phase2-submitqueue-stable:functions_clean/index.mjs" >/dev/null 2>&1; then
  git show "refs/tags/phase2-submitqueue-stable:functions_clean/index.mjs" > functions_clean/index.mjs
  echo "✅ restored functions_clean/index.mjs from phase2-submitqueue-stable"
else
  git checkout -- functions_clean/index.mjs
  echo "✅ restored functions_clean/index.mjs from working tree"
fi

echo "==> (5) Ensure handlers exist (NO self-export inside handler files)"
# getContractsV1.mjs
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

export async function handleGetContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });

    const db = getFirestore();
    const snap = await db.collection("contracts")
      .where("orgId","==",orgId)
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
MJS

# getContractV1.mjs
cat > functions_clean/getContractV1.mjs <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

export async function handleGetContractV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const ref = db.collection("contracts").doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Contract not found" });

    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) {
      return res.status(403).json({ ok:false, error:"Wrong orgId for contract" });
    }
    return res.json({ ok:true, orgId, contractId, doc: { id:snap.id, ...data }});
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
MJS

echo "✅ wrote functions_clean/getContractsV1.mjs + getContractV1.mjs"

echo "==> (6) Patch functions_clean/index.mjs: add imports near top + exports at EOF"
python3 - <<'PY'
from pathlib import Path
p=Path("functions_clean/index.mjs")
s=p.read_text()

# Insert imports right after the first onRequest import line (or at top)
import_block = (
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n'
)

if import_block.strip() not in s:
  lines = s.splitlines(True)
  insert_at = 0
  for i,ln in enumerate(lines[:50]):
    if "from \"firebase-functions/v2/https\"" in ln or "from 'firebase-functions/v2/https'" in ln:
      insert_at = i+1
      break
  lines.insert(insert_at, import_block)
  s = "".join(lines)

# Remove any stray/old exports for these two names
import re
s = re.sub(r'^\s*export\s+const\s+getContractsV1\s*=.*\n', '', s, flags=re.M)
s = re.sub(r'^\s*export\s+const\s+getContractV1\s*=.*\n', '', s, flags=re.M)

# Append exports at EOF (guaranteed top-level)
export_block = (
  '\n// === contracts endpoints ===\n'
  'export const getContractsV1 = onRequest(handleGetContractsV1);\n'
  'export const getContractV1 = onRequest(handleGetContractV1);\n'
)

if "export const getContractsV1" not in s:
  s = s.rstrip() + "\n" + export_block

p.write_text(s)
print("✅ patched functions_clean/index.mjs (imports + EOF exports)")
PY

echo "==> (7) ESM sanity (THIS is the only check that matters)"
node --input-type=module -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM_IMPORT_OK')).catch(e=>{console.error('❌ ESM_IMPORT_FAIL'); console.error(e); process.exit(1)})"

echo "==> (8) Start emulators (functions + firestore)"
nohup firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"
sleep 2

echo "==> (9) Start Next (port 3000)"
pushd next-app >/dev/null
nohup pnpm dev --port 3000 > ../.logs/next.log 2>&1 &
NEXT_PID=$!
popd >/dev/null
echo "NEXT_PID=$NEXT_PID"
sleep 2

echo "==> (10) Smoke (emulator endpoints)"
curl -sS "$FN_BASE/hello" | head -n 1 || true
echo
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=car_abc123" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
