#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

mkdir -p .logs

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"

echo "==> (0) hard-kill stray listeners + emulators + next"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true

echo "==> (1) start emulators (functions+firestore) using firebase.emu.json"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (2) wait for functions /hello"
for i in $(seq 1 160); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done
if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions not ready"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi

echo "==> (3) detect Firestore emulator port (8080 vs 8081)"
FS_PORT=""
for p in 8081 8080; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    FS_PORT="$p"
    break
  fi
done
if [[ -z "$FS_PORT" ]]; then
  echo "❌ could not find firestore emulator port (expected 8080 or 8081)"
  lsof -iTCP -sTCP:LISTEN | rg "8080|8081" || true
  exit 1
fi
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

echo "==> (4) seed contract doc into Firestore emulator"
node - <<NODE
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
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
})().catch((e)=>{ console.error(e); process.exit(1); });
NODE

echo "==> (5) seed 5 payload docs via emulator writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  echo "   -> $TYPE ($SCHEMA)"
  local BODY
  BODY="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" )"
  echo "$BODY" | python3 -m json.tool >/dev/null 2>&1 || {
    echo "❌ non-json response:"
    echo "$BODY" | head -c 500; echo
    exit 1
  }
  echo "$BODY" | python3 -m json.tool | head -n 25
}
post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

echo "==> (6) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 160); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next up (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done
if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next not ready"
  tail -n 120 .logs/next.log || true
  exit 1
fi

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
