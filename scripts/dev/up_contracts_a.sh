#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail


lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

cd ~/peakops/my-app

# ---- config
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
ORG_ID="${ORG_ID:-org_001}"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

echo "==> ORG_ID=$ORG_ID"
echo "==> FN_BASE=$FN_BASE"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> CUSTOMER_ID=$CUSTOMER_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo

# ---- kill ports
echo "==> killing ports"
for p in 3000 5001 8081 4400 4401 4409 4500 4501 4509 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done

# ---- start emulators
echo "==> start emulators (functions+firestore) [background]"
mkdir -p .logs
(firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1) &
EMU_PID=$!

# wait for hello
echo "==> wait for functions /hello"
for i in $(seq 1 80); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" | python3 -m json.tool | head -n 30
echo "✅ functions ok"
echo

# ---- seed contract in emulator (Firestore emulator host)
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"

node - <<'NODE'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const ORG_ID = process.env.ORG_ID || "org_001";
const CONTRACT_ID = process.env.CONTRACT_ID || "car_abc123";
const CUSTOMER_ID = process.env.CUSTOMER_ID || "cust_acme_001";

if (!getApps().length) initializeApp({ projectId: "peakops-pilot" });
const db = getFirestore();

await db.collection("contracts").doc(CONTRACT_ID).set({
  orgId: ORG_ID,
  orgid: ORG_ID,            // keep both until we fully normalize
  contractNumber: "CTR-2025-0001",
  customerId: CUSTOMER_ID,
  type: "MSA",
  status: "ACTIVE",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });

console.log("✅ seeded emulator contract:", `contracts/${CONTRACT_ID}`);
NODE
echo

# ---- seed payload docs via local functions emulator (writeContractPayloadV1)
unset FIRESTORE_EMULATOR_HOST

post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local DOC="v1_$(lower "$TYPE")"
  DOC="${DOC/oe_417/oe_417}"   # keep naming stable
  echo "==> seed payload: ${DOC_ID} (${TYPE} / ${SCHEMA})"
REQ_JSON="$(python3 - <<'PYIN'
import json, os
print(json.dumps({
  "orgId": os.environ.get("ORG_ID",""),
  "contractId": os.environ.get("CONTRACT_ID",""),
  "type": os.environ.get("TYPE",""),
  "versionId": os.environ.get("VERSION_ID",""),
  "schemaVersion": os.environ.get("SCHEMA",""),
  "payload": {"_placeholder":"INIT"},
  "createdBy": "admin_ui",
}))
PYIN
)"
# IMPORTANT: capture body + status so we can see why it's not JSON
RESP="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
  -H "Content-Type: application/json" \
  --data-binary "$REQ_JSON" \
  -w "\n__HTTP_STATUS__:%{http_code}\n")"

# Split body/status
BODY="${RESP%$'\n__HTTP_STATUS__:'*}"
STATUS="${RESP##*__HTTP_STATUS__:}"

if [ "$STATUS" != "200" ]; then
  echo "❌ writeContractPayloadV1 HTTP $STATUS"
  echo "---- raw body (first 400 chars) ----"
  echo "$BODY" | head -c 400; echo
  exit 1
fi

# Must be JSON
echo "$BODY" | python3 -m json.tool | head -n 80
echo
  echo
}

post "BABA"   "baba.v1"
post "DIRS"   "dirs.v1"
post "NORS"   "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"    "sar.v1"

echo "==> smoke: getContractPayloadsV1"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60
echo

# ---- start Next
echo "==> start Next (port 3000) [background]"
(cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1) &
NEXT_PID=$!

echo "==> wait for Next"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ next OK"
echo

echo "==> smoke: Next API proxies"
curl -sS "http://localhost:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=50" | python3 -m json.tool | head -n 40 || true
curl -sS "http://localhost:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 40 || true
curl -sS "http://localhost:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 40 || true
echo

echo "✅ UI:"
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
