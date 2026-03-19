#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/${PROJECT_ID}/us-central1}"

mkdir -p .logs

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"
echo "==> (0) kill ports + stray processes"
lsof -tiTCP:3000,5001,8081,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.5

echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start \
  --only functions,firestore \
  --project "$PROJECT_ID" \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (2) wait for Firestore port 8081"
for i in $(seq 1 120); do
  (echo > /dev/tcp/127.0.0.1/8081) >/dev/null 2>&1 && break
  sleep 0.25
done
if ! (echo > /dev/tcp/127.0.0.1/8081) >/dev/null 2>&1; then
  echo "❌ Firestore emulator never opened 8081"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi
echo "✅ firestore port ok"

echo "==> (3) wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions /hello never became ready"
  tail -n 160 .logs/emulators.log || true
  exit 1
fi
echo "✅ functions ok (FN_BASE=$FN_BASE)  (pid=$EMU_PID)"

echo "==> (4) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next never became ready on :3000"
  tail -n 120 .logs/next.log || true
  exit 1
fi
echo "✅ next ok (pid=$NEXT_PID)"

echo "==> (5) seed contract doc into Firestore EMULATOR (FORCED)"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export GCLOUD_PROJECT="$PROJECT_ID"

node - <<NODE
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

(async () => {
  await db.collection("contracts").doc("${CONTRACT_ID}").set({
    orgId: "${ORG_ID}",
    orgid: "${ORG_ID}",
    contractNumber: "CTR-2025-0001",
    status: "ACTIVE",
    type: "MSA",
    customerId: "${CUSTOMER_ID}",
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
})();
NODE

echo "==> (6) seed payload docs via emulator function writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local RESP
  RESP="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" )"

  echo "$RESP" | python3 -m json.tool >/dev/null 2>&1 || {
    echo "❌ non-json response from writeContractPayloadV1:"
    echo "$RESP" | head -c 400; echo
    echo "--- emulators tail ---"
    tail -n 120 .logs/emulators.log || true
    exit 1
  }

  echo "$RESP" | python3 -m json.tool | head -n 40
  echo
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 160 .logs/emulators.log"
echo "  tail -n 160 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
