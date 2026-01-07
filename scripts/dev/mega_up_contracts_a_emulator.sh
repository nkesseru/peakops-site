#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app
mkdir -p .logs scripts/dev

# args
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

# env
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

ORG_ID="${ORG_ID:-org_001}"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"

echo "==> ORG_ID=$ORG_ID"
echo "==> FN_BASE=$FN_BASE"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> CUSTOMER_ID=$CUSTOMER_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo

FILE="functions_clean/index.mjs"
cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"

echo "==> (1) Ensure functions_clean/index.mjs exports contract endpoints (re-export style)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

need = [
  'export { getContractsV1 } from "./getContractsV1.mjs";',
  'export { getContractV1 } from "./getContractV1.mjs";',
  'export { getContractPayloadsV1 } from "./getContractPayloadsV1.mjs";',
  'export { writeContractPayloadV1 } from "./writeContractPayloadV1.mjs";',
]

# place after hello export if present; else near top after imports
anchor = "export const hello"
if anchor in s:
  idx = s.find(anchor)
  # insert after hello block end "});"
  end = s.find("});", idx)
  if end != -1:
    end = end + 3
    insert_at = end
  else:
    insert_at = idx
else:
  # fallback: after last import line
  last_import = s.rfind("import ")
  insert_at = s.find("\n", last_import) if last_import != -1 else 0

to_add = [x for x in need if x not in s]
if to_add:
  block = "\n\n// --- contracts v1 exports ---\n" + "\n".join(to_add) + "\n// --- end contracts v1 exports ---\n"
  s = s[:insert_at] + block + s[insert_at:]
  p.write_text(s)
  print("✅ added exports to functions_clean/index.mjs")
else:
  print("✅ exports already present in functions_clean/index.mjs")
PY

echo "==> (2) Kill ports + stray dev"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true

echo "==> (3) Start emulators (functions+firestore) [background]"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "==> smoke: hello"
curl -sS "$FN_BASE/hello" | head -c 120; echo
echo "✅ functions ok (pid=$EMU_PID)"
echo

echo "==> (4) Start Next (port 3000) [background]"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 160); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ next ok (pid=$NEXT_PID)"
echo

echo "==> (5) Seed contract doc into emulator Firestore"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
if (!getApps().length) initializeApp({ projectId: "peakops-pilot" });
const db = getFirestore();

await db.collection("contracts").doc("${CONTRACT_ID}").set({
  orgId: "${ORG_ID}",
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId: "${CUSTOMER_ID}",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });

console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
NODE
echo

post_payload () {
  local TYPE="$1"
  local SCHEMA="$2"
  local DOCID="${VERSION_ID}_$(echo "$TYPE" | tr '[:upper:]' '[:lower:]')"

  echo "==> seed payload: $DOCID ($TYPE / $SCHEMA)"
  RESP="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"$ORG_ID\",
      \"contractId\":\"$CONTRACT_ID\",
      \"type\":\"$TYPE\",
      \"versionId\":\"$VERSION_ID\",
      \"schemaVersion\":\"$SCHEMA\",
      \"payload\": { \"_placeholder\":\"INIT\" },
      \"createdBy\":\"admin_ui\"
    }" \
    -w $'\n__HTTP_STATUS__:%{http_code}')"

  BODY="${RESP%$'\n__HTTP_STATUS__:'*}"
  STATUS="${RESP##*__HTTP_STATUS__:}"

  if [ "$STATUS" != "200" ]; then
    echo "❌ writeContractPayloadV1 HTTP $STATUS"
    echo "---- raw body (first 400 chars) ----"
    echo "$BODY" | head -c 400; echo
    echo "---- tail emulators.log ----"
    tail -n 80 .logs/emulators.log || true
    exit 1
  fi

  echo "$BODY" | python3 -m json.tool | head -n 60
  echo
}

echo "==> (6) Seed 5 payload docs"
post_payload "BABA" "baba.v1"
post_payload "DIRS" "dirs.v1"
post_payload "NORS" "nors.v1"
post_payload "OE_417" "oe_417.v1"
post_payload "SAR" "sar.v1"

echo "==> (7) Smoke: direct function reads"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=10" | python3 -m json.tool | head -n 60 || true
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 60 || true
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60 || true
echo

echo "==> (8) Smoke: Next API proxies"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=10" | python3 -m json.tool | head -n 60 || true
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 60 || true
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60 || true
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
