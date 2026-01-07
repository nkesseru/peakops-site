#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"

REPO="$(pwd)"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID version=$VERSION_ID"
echo "==> repo=$REPO"
echo

echo "==> (0) Kill ports (3000/5001/8080/8081/4000/4409/9150)"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Ensure Next points to emulator FN_BASE + default orgId"
mkdir -p next-app
touch next-app/.env.local
# remove existing FN_BASE lines
grep -v '^FN_BASE=' next-app/.env.local > next-app/.env.local.tmp || true
mv next-app/.env.local.tmp next-app/.env.local
{
  echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}"
  echo "FN_BASE=${FN_BASE}"
} >> next-app/.env.local

echo "✅ next-app/.env.local set:"
tail -n 5 next-app/.env.local
echo

echo "==> (2) Start emulators (functions+firestore) in background"
mkdir -p .logs
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (3) Wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)  FN_BASE=$FN_BASE"
    break
  fi
  sleep 0.25
done

# Detect firestore port (8080 vs 8081)
FS_PORT=""
for p in 8080 8081; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    FS_PORT="$p"
    break
  fi
done
if [ -z "$FS_PORT" ]; then
  echo "❌ Could not detect Firestore emulator port (8080/8081)."
  tail -n 80 .logs/emulators.log || true
  exit 1
fi
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"
echo

echo "==> (4) Seed contract doc into Firestore emulator"
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
    customerId: "cust_acme_001",
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log("✅ seeded contracts/${CONTRACT_ID}");
})();
NODE
echo

echo "==> (5) Seed 5 payload docs via emulator writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local BODY
  BODY="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"${ORG_ID}\",\"contractId\":\"${CONTRACT_ID}\",\"type\":\"${TYPE}\",\"versionId\":\"${VERSION_ID}\",\"schemaVersion\":\"${SCHEMA}\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" )"

  echo "$BODY" | python3 -m json.tool >/dev/null 2>&1 || {
    echo "❌ non-json response from writeContractPayloadV1:"
    echo "$BODY" | head -c 500; echo
    exit 1
  }
  echo "   -> ${TYPE} (${SCHEMA})"
  echo "$BODY" | python3 -m json.tool | head -n 40
}
post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"
echo

echo "==> (6) Start Next dev (port 3000) in background"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "==> (7) Smoke"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=${ORG_ID}&limit=5" | head -c 200; echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}" | head -c 200; echo

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/packet?orgId=${ORG_ID}&versionId=${VERSION_ID}"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
