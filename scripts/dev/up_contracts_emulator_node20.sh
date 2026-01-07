#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app
mkdir -p .logs

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

# Functions emulator base (this is correct for emulators)
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> PROJECT_ID=$PROJECT_ID"
echo "==> ORG_ID=$ORG_ID"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> CUSTOMER_ID=$CUSTOMER_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo "==> FN_BASE=$FN_BASE"
echo

echo "==> (1) Kill stray listeners (safe)"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
sleep 0.5

echo "==> (2) Start emulators (FORCED Node 20; no fnm needed)"
# Force Node 20 just for firebase tools to avoid ESM crash
( npx -y node@20 "$(command -v firebase)" emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 ) &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> (3) Wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ok"
    break
  fi
  sleep 0.25
done

echo "==> (4) Start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> (5) Wait for Next"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ok"
    break
  fi
  sleep 0.25
done

echo "==> (6) Seed emulator Firestore contract doc"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();
await db.collection("contracts").doc("${CONTRACT_ID}").set({
  orgId: "${ORG_ID}",
  customerId: "${CUSTOMER_ID}",
  contractNumber: "CTR-2025-0001",
  type: "MSA",
  status: "ACTIVE",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });
console.log("✅ seeded emulator contract: contracts/${CONTRACT_ID}");
NODE

echo "==> (7) Seed 5 payload docs via emulator function writeContractPayloadV1"
post () {
  local TYPE="$1"
  local SCHEMA="$2"
  local DOCID="${VERSION_ID}_$(echo "$TYPE" | tr '[:upper:]' '[:lower:]')"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"${ORG_ID}\",
      \"contractId\":\"${CONTRACT_ID}\",
      \"type\":\"${TYPE}\",
      \"versionId\":\"${VERSION_ID}\",
      \"schemaVersion\":\"${SCHEMA}\",
      \"payloadDocId\":\"${DOCID}\",
      \"payload\": {\"_placeholder\":\"INIT\"},
      \"createdBy\":\"admin_ui\"
    }"
  echo
}

post "BABA"  "baba.v1"   | python3 -m json.tool | head -n 30
post "DIRS"  "dirs.v1"   | python3 -m json.tool | head -n 30
post "NORS"  "nors.v1"   | python3 -m json.tool | head -n 30
post "OE_417" "oe_417.v1" | python3 -m json.tool | head -n 30
post "SAR"   "sar.v1"    | python3 -m json.tool | head -n 30

echo "==> (8) Smoke: getContractPayloadsV1 (emulator)"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}&limit=50" | python3 -m json.tool | head -n 60

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads/v1_dirs?orgId=${ORG_ID}"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
