#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Ensure fnm + Node 20"
if ! command -v fnm >/dev/null 2>&1; then
  echo "Installing fnm via brew..."
  brew install fnm
fi
eval "$(fnm env)"
fnm install 20 >/dev/null
fnm use 20 >/dev/null
echo "✅ node=$(node -v)"

echo
echo "==> (1) Load env"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"

echo
echo "==> (2) Kill ports/procs"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:4409 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pkill -f "firebase.*emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
echo "✅ cleared"

echo
echo "==> (3) Force functions_clean to ESM"
python3 - <<'PY'
import json
from pathlib import Path
p=Path("functions_clean/package.json")
d=json.loads(p.read_text())
d["type"]="module"
d["main"]="index.mjs"
d.setdefault("engines",{})["node"]="20"
p.write_text(json.dumps(d, indent=2)+"\n")
print("✅ functions_clean/package.json normalized")
PY

echo
echo "==> (4) Restore clean index.mjs from known-good tag"
TAG="phase2-submitqueue-stable"
git show "$TAG:functions_clean/index.mjs" > functions_clean/index.mjs
echo "✅ restored functions_clean/index.mjs from $TAG"

echo
echo "==> (5) Write clean getContractsV1 + getContractV1"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  const orgId = String(req.query.orgId || "").trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });

  const snap = await db.collection("contracts")
    .where("orgId","==",orgId)
    .limit(limit)
    .get();

  const docs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  return res.json({ ok:true, orgId, count: docs.length, docs });
}

export const getContractsV1 = onRequest(handleGetContractsV1);
MJS

cat > functions_clean/getContractV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  const orgId = String(req.query.orgId || "").trim();
  const contractId = String(req.query.contractId || "").trim();
  if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });
  if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

  const snap = await db.collection("contracts").doc(contractId).get();
  if (!snap.exists) return res.status(404).json({ ok:false, error:"Contract not found" });

  const data = snap.data() || {};
  if (String(data.orgId || "") !== orgId) return res.status(403).json({ ok:false, error:"orgId mismatch" });

  return res.json({ ok:true, orgId, contractId, contract: { id: snap.id, ...data } });
}

export const getContractV1 = onRequest(handleGetContractV1);
MJS

echo "✅ wrote handlers"

echo
echo "==> (6) Patch functions_clean/index.mjs (imports + exports)"
python3 - <<'PY'
from pathlib import Path
p=Path("functions_clean/index.mjs")
s=p.read_text()

# insert imports right after onRequest import
needle = 'import { onRequest } from "firebase-functions/v2/https";\n'
i = s.find(needle)
if i == -1:
  raise SystemExit("❌ could not find onRequest import")
insert_at = i + len(needle)

imports = [
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n',
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n',
]
for imp in imports[::-1]:
  if imp.strip() not in s:
    s = s[:insert_at] + imp + s[insert_at:]

# ensure exports exist exactly once AFTER hello handler ends
if "export const getContractsV1" not in s:
  anchor = "export const hello = onRequest"
  a = s.find(anchor)
  if a == -1:
    raise SystemExit("❌ could not find hello export")
  end = s.find("});", a)
  if end == -1:
    raise SystemExit("❌ could not find end of hello handler")
  end += 3
  s = s[:end] + "\nexport const getContractsV1 = onRequest(handleGetContractsV1);\nexport const getContractV1 = onRequest(handleGetContractV1);\n" + s[end:]

p.write_text(s)
print("✅ patched index.mjs")
PY

echo
echo "==> (7) ESM import sanity (must pass)"
node --input-type=module -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM_IMPORT_OK')).catch(e=>{console.error('❌ ESM_IMPORT_FAIL');console.error(e);process.exit(1)})"

echo
echo "==> (8) Start emulators"
mkdir -p .logs
firebase emulators:start --only functions,firestore > .logs/emulators.log 2>&1 &
EMU_PID=$!

for i in $(seq 1 80); do
  if curl -sS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions emulator up"
    break
  fi
  sleep 0.5
done

echo
echo "==> (9) Start Next"
(cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 &)
NEXT_PID=$!

for i in $(seq 1 80); do
  if curl -sS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next up"
    break
  fi
  sleep 0.5
done

echo
echo "==> (10) Smoke"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=car_abc123" | python3 -m json.tool | head -n 80 || true
echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 60 || true

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
