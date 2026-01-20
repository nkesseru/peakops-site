#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
ORG_ID="${ORG_ID:-org_001}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"
mkdir -p .logs

echo "==> (0) kill ports + stray procs"
for p in 3000 3001 3002 5001 8081 4409 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done
pkill -f "firebase.*emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true

echo "==> (1) build emulator-only functions bundle (CJS) into functions_emu/"
rm -rf functions_emu
rsync -a --delete functions_clean/ functions_emu/

# ensure esbuild available without pnpm workspace semantics
cd functions_emu
if ! command -v npx >/dev/null 2>&1; then
  echo "❌ npx missing. Install Node/npm first."
  exit 1
fi

# install esbuild locally (npm, not pnpm)
npm install --silent --no-progress esbuild >/dev/null 2>&1 || true

# bundle ESM -> CJS for emulator loader
npx --yes esbuild index.mjs --bundle --platform=node --format=cjs --outfile=index.cjs >/dev/null

# force CJS entry
python3 - <<'PY'
import json
from pathlib import Path
p = Path("package.json")
d = json.loads(p.read_text())
d.pop("type", None)              # emulator loader uses require()
d["main"] = "index.cjs"
d.setdefault("engines", {})["node"] = "20"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_emu/package.json -> main=index.cjs (CJS)")
PY

cd ~/peakops/my-app

echo "==> (2) point firebase.json functions.source -> functions_emu (backup + patch)"
cp -f firebase.json firebase.json.bak_contracts_emu || true
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
d = json.loads(p.read_text())
d.setdefault("functions", {})
d["functions"]["source"] = "functions_emu"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ firebase.json patched to functions_emu")
PY

echo "==> (3) start emulators (functions, firestore) [background]"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (4) wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ok"
    break
  fi
  sleep 0.25
done

echo "==> (5) start Next on :3000 [background]"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ok"
    break
  fi
  sleep 0.25
done

echo "==> (6) seed emulator Firestore: contracts/$CONTRACT_ID"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();

await db.collection("contracts").doc("${CONTRACT_ID}").set({
  orgId: "${ORG_ID}",
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId: "${CUSTOMER_ID}",
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });

console.log("✅ seeded contract");
NODE

echo "==> (7) seed 5 payload docs via emulator function writeContractPayloadV1"
unset FIRESTORE_EMULATOR_HOST

post() {
  local TYPE="$1"
  local SCHEMA="$2"
  curl -fsS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"$ORG_ID\",
      \"contractId\":\"$CONTRACT_ID\",
      \"type\":\"$TYPE\",
      \"versionId\":\"$VERSION_ID\",
      \"schemaVersion\":\"$SCHEMA\",
      \"payload\": { \"_placeholder\":\"INIT\" },
      \"createdBy\":\"admin_ui\"
    }" >/dev/null
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"
echo "✅ seeded payload docs"

echo "==> (8) smoke: getContractPayloadsV1"
curl -fsS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
