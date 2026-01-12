#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
CUSTOMER_ID="${4:-cust_acme_001}"
VERSION_ID="${5:-v1}"

cd ~/peakops/my-app
mkdir -p .logs

echo "==> boot_contracts_seed_green"
echo "project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID"

echo "==> (0) hard-kill ports"
lsof -tiTCP:3000,5001,8081,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.5

echo "==> (1) start emulators (functions+firestore)"
# force functions source to functions_clean
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
j = json.loads(p.read_text())
j.setdefault("functions", {})["source"] = "functions_clean"
p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ firebase.json functions.source = functions_clean")
PY

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"

echo "==> (2) wait for functions /hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" | head -c 120; echo
echo "✅ emulators ready (pid=$EMU_PID)"

echo "==> (3) set Next proxy env"
cat > next-app/.env.local <<EOF
FN_BASE=$FN_BASE
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID
EOF
echo "✅ next-app/.env.local written"

echo "==> (4) seed Firestore emulator"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
bash scripts/dev/seed_contract_and_payloads_emulator.sh "$PROJECT_ID" "$ORG_ID" "$CONTRACT_ID" "$CUSTOMER_ID" "$VERSION_ID"

echo "==> (5) start Next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:3000/" >/dev/null 2>&1 && break
  sleep 0.25
done
echo "✅ next up (pid=$NEXT_PID)"

echo "==> (6) SMOKE: Next -> fnProxy -> emulator"
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 240; echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=5" | head -c 240; echo
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=$ORG_ID&incidentId=inc_TEST" | head -c 240; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
