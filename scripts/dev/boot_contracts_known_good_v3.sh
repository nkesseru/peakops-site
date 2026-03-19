#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
CUSTOMER_ID="${4:-cust_acme_001}"
VERSION_ID="${5:-v1}"

cd ~/peakops/my-app
mkdir -p .logs

echo "==> boot_contracts_known_good_v3"
echo "project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID"

echo
echo "==> (0) hard-kill ports (3000/5001/8080/8081/4000/4409/9150)"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo
echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"

echo
echo "==> (2) wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done
if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi

echo
echo "==> (3) point Next proxy at emulator + default orgId"
# ensure env file exists
mkdir -p next-app
touch next-app/.env.local
# set/replace vars
if grep -q '^FN_BASE=' next-app/.env.local; then
  sed -i '' "s|^FN_BASE=.*|FN_BASE=$FN_BASE|g" next-app/.env.local
else
  echo "FN_BASE=$FN_BASE" >> next-app/.env.local
fi
if grep -q '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' next-app/.env.local; then
  sed -i '' "s|^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=.*|NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID|g" next-app/.env.local
else
  echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID" >> next-app/.env.local
fi
echo "✅ next-app/.env.local set:"
echo "  FN_BASE=$FN_BASE"
echo "  NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID"

echo
echo "==> (4) seed contract doc into Firestore EMULATOR"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export GCLOUD_PROJECT="$PROJECT_ID"

node - <<NODE
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });

const db = admin.firestore();
(async () => {
  await db.collection("contracts").doc("${CONTRACT_ID}").set({
    id: "${CONTRACT_ID}",
    orgId: "${ORG_ID}",
    orgid: "${ORG_ID}",
    customerId: "${CUSTOMER_ID}",
    contractNumber: "CTR-2025-0001",
    type: "MSA",
    status: "ACTIVE",
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
NODE

echo
echo "==> (5) seed payload docs via emulator function writeContractPayloadV1"
post_payload () {
  local TYPE="$1"
  local SCHEMA="$2"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
    | python3 -m json.tool >/dev/null
  echo "✅ payload: $TYPE ($SCHEMA)"
}
post_payload "BABA" "baba.v1"
post_payload "DIRS" "dirs.v1"
post_payload "NORS" "nors.v1"
post_payload "OE_417" "oe_417.v1"
post_payload "SAR"  "sar.v1"

echo
echo "==> (6) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done
if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next never became ready"
  tail -n 120 .logs/next.log || true
  exit 1
fi

echo
echo "==> (7) smoke (Next -> fnProxy -> emulator)"
echo "-- hello --"
curl -sS "$FN_BASE/hello" | head -c 120; echo
echo "-- getContractV1 via Next --"
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 220; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo
echo "EDIT (safe nano for [id] paths in zsh):"
echo "  noglob nano \"next-app/src/app/admin/contracts/[id]/page.tsx\""
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
