#!/usr/bin/env bash
set -euo pipefail
set +H

cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"
INCIDENT_ID="${5:-inc_TEST}"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> boot_phase2_stack_canonical"
echo "project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID version=$VERSION_ID incident=$INCIDENT_ID"
echo

# ------------------------------------------------------------
# (0) Kill common ports + stray processes (safe)
# ------------------------------------------------------------
echo "==> (0) kill ports + stray emulators/next"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.4

# ------------------------------------------------------------
# (1) Start emulators
# ------------------------------------------------------------
echo "==> (1) start emulators (functions + firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
FS_HOST="127.0.0.1:8081" # default tool output often shows 8081; we'll detect below

# Wait for hello
echo "==> (2) wait for functions /hello"
for i in $(seq 1 160); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready"
    break
  fi
  sleep 0.25
done

# Detect firestore port (8080 vs 8081)
echo "==> (3) detect firestore emulator port"
if curl -fsS "http://127.0.0.1:8081" >/dev/null 2>&1; then
  FS_HOST="127.0.0.1:8081"
elif curl -fsS "http://127.0.0.1:8080" >/dev/null 2>&1; then
  FS_HOST="127.0.0.1:8080"
fi
echo "✅ FIRESTORE=$FS_HOST"

# ------------------------------------------------------------
# (4) Seed Firestore emulator: contracts/{contractId}
#     + payload subcollection 5 docs (baba/dirs/nors/oe417/sar)
# ------------------------------------------------------------
echo "==> (4) seed Firestore emulator (contract + payload docs)"

FS_DOCS="http://${FS_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents"

now_iso="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

# contract doc
curl -fsS -X POST \
  "${FS_DOCS}/contracts?documentId=${CONTRACT_ID}" \
  -H "Content-Type: application/json" \
  -d @- >/dev/null <<JSON
{
  "fields": {
    "id": {"stringValue": "${CONTRACT_ID}"},
    "orgId": {"stringValue": "${ORG_ID}"},
    "contractNumber": {"stringValue": "CTR-2025-0001"},
    "type": {"stringValue": "MSA"},
    "status": {"stringValue": "ACTIVE"},
    "customerId": {"stringValue": "cust_acme_001"},
    "updatedAt": {"timestampValue": "${now_iso}"}
  }
}
JSON

seed_payload () {
  local docId="$1"
  local schema="$2"
  local typ="$3"
  curl -fsS -X POST \
    "${FS_DOCS}/contracts/${CONTRACT_ID}/payloads?documentId=${docId}" \
    -H "Content-Type: application/json" \
    -d @- >/dev/null <<JSON
{
  "fields": {
    "id": {"stringValue": "${docId}"},
    "orgId": {"stringValue": "${ORG_ID}"},
    "contractId": {"stringValue": "${CONTRACT_ID}"},
    "versionId": {"stringValue": "${VERSION_ID}"},
    "schemaVersion": {"stringValue": "${schema}"},
    "type": {"stringValue": "${typ}"},
    "createdBy": {"stringValue": "seed"},
    "payloadHash": {"stringValue": "seed_${docId}"},
    "payload": {
      "mapValue": {
        "fields": {
          "_placeholder": {"stringValue": "INIT"}
        }
      }
    },
    "createdAt": {"timestampValue": "${now_iso}"},
    "updatedAt": {"timestampValue": "${now_iso}"}
  }
}
JSON
}

seed_payload "${VERSION_ID}_baba"   "baba.v1"   "BABA"
seed_payload "${VERSION_ID}_dirs"   "dirs.v1"   "DIRS"
seed_payload "${VERSION_ID}_nors"   "nors.v1"   "NORS"
seed_payload "${VERSION_ID}_oe_417" "oe_417.v1" "OE_417"
seed_payload "${VERSION_ID}_sar"    "sar.v1"    "SAR"

echo "✅ seeded contracts/${CONTRACT_ID} + 5 payload docs"

# ------------------------------------------------------------
# (5) Point Next at emulator + start Next
# ------------------------------------------------------------
echo "==> (5) set next-app/.env.local FN_BASE -> emulator"
mkdir -p next-app
touch next-app/.env.local
grep -q '^FN_BASE=' next-app/.env.local && \
  sed -i.bak "s#^FN_BASE=.*#FN_BASE=${FN_BASE}#g" next-app/.env.local || \
  echo "FN_BASE=${FN_BASE}" >> next-app/.env.local

grep -q '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' next-app/.env.local && \
  sed -i.bak "s#^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=.*#NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}#g" next-app/.env.local || \
  echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}" >> next-app/.env.local

( cd next-app && pnpm dev --port 3000 > ../"$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!

# wait for Next
echo "==> (6) wait for Next :3000"
for i in $(seq 1 160); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

# ------------------------------------------------------------
# (7) Smoke everything (direct + via Next proxy)
# ------------------------------------------------------------
echo "==> (7) smoke (direct functions)"
echo "-- hello --"
curl -sS "$FN_BASE/hello" | head -c 160; echo
echo "-- getContractsV1 --"
curl -sS "$FN_BASE/getContractsV1?orgId=${ORG_ID}&limit=5" | head -c 240; echo
echo "-- getContractV1 --"
curl -sS "$FN_BASE/getContractV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}" | head -c 280; echo
echo "-- getContractPayloadsV1 --"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}&limit=50" | head -c 240; echo
echo

echo "==> (8) smoke (via Next proxy)"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=${ORG_ID}&limit=5" | head -c 240; echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}" | head -c 280; echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}&limit=50" | head -c 240; echo
curl -sS "http://127.0.0.1:3000/api/fn/exportContractPacketV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}&versionId=${VERSION_ID}&limit=200" | head -c 240; echo
echo

echo "==> (9) smoke Phase2 workflow endpoint"
WF_URL="http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
echo "GET $WF_URL"
RAW="$(curl -sS "$WF_URL" || true)"
if echo "$RAW" | python3 -m json.tool >/dev/null 2>&1; then
  echo "$RAW" | python3 -m json.tool | head -n 80
  echo "✅ getWorkflowV1 returned JSON"
else
  echo "❌ getWorkflowV1 returned non-JSON. First 220 chars:"
  echo "$RAW" | head -c 220; echo
  echo
  echo "First errors from next.log:"
  tail -n 40 "$LOGDIR/next.log" || true
  echo
  echo "First errors from emulators.log:"
  tail -n 40 "$LOGDIR/emulators.log" || true
fi

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/packet?orgId=${ORG_ID}&versionId=${VERSION_ID}"
echo "  http://localhost:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
