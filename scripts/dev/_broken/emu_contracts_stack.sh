#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

ROOT="$(pwd)"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID"

# --- 0) Kill stray listeners ---
echo "==> (0) kill ports"
for p in 3000 3001 3002 5001 8081 4400 4401 4409 4500 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done

# --- 1) Ensure esbuild exists ---
if ! command -v esbuild >/dev/null 2>&1; then
  echo "==> (1) install esbuild (dev dep)"
  pnpm -w add -D esbuild >/dev/null
fi

# --- 2) Build emulator bundle (CJS) from functions_clean/index.mjs ---
echo "==> (2) build functions_emulator bundle (CJS)"
rm -rf functions_emulator
mkdir -p functions_emulator

cat > functions_emulator/package.json <<'JSON'
{
  "name": "functions_emulator",
  "private": true,
  "main": "index.js"
}
JSON

# Bundle to CJS so the emulator can require() it.
esbuild functions_clean/index.mjs \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node20 \
  --outfile=functions_emulator/index.js \
  >/dev/null

node --check functions_emulator/index.js >/dev/null
echo "✅ bundle OK"

# --- 3) Generate a dedicated emulator config so deploy config stays untouched ---
echo "==> (3) write firebase.emu.json (functions.source=functions_emulator)"
python3 - <<'PY'
import json
from pathlib import Path
src = Path("firebase.json")
cfg = json.loads(src.read_text())
cfg.setdefault("functions", {})
cfg["functions"]["source"] = "functions_emulator"
Path("firebase.emu.json").write_text(json.dumps(cfg, indent=2))
print("✅ wrote firebase.emu.json")
PY

# --- 4) Start emulators using the emulator config ---
echo "==> (4) start emulators"
firebase emulators:start --config firebase.emu.json --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ emulators up (pid=$EMU_PID)  FN_BASE=$FN_BASE"

# --- 5) Start Next ---
echo "==> (5) start next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ next up (pid=$NEXT_PID)"

# --- 6) Seed contract doc into Firestore emulator ---
echo "==> (6) seed contract doc (firestore emulator)"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
node - <<'NODE'
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp({ projectId: "peakops-pilot" });
const db = getFirestore();

(async () => {
  const orgId = process.env.ORG_ID;
  const contractId = process.env.CONTRACT_ID;
  const customerId = process.env.CUSTOMER_ID;
  await db.collection("contracts").doc(contractId).set({
    orgId,
    customerId,
    contractNumber: "CTR-2025-0001",
    status: "ACTIVE",
    type: "MSA",
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log("✅ seeded emulator contract:", `contracts/${contractId}`);
})();
NODE

# --- 7) Seed 5 payload docs via emulator function writeContractPayloadV1 ---
echo "==> (7) seed payloads via emulator function writeContractPayloadV1"
post () {
  local TYPE="$1"
  local SCHEMA="$2"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"$ORG_ID\",
      \"contractId\":\"$CONTRACT_ID\",
      \"type\":\"$TYPE\",
      \"versionId\":\"$VERSION_ID\",
      \"schemaVersion\":\"$SCHEMA\",
      \"payload\": { \"_placeholder\":\"INIT\" },
      \"createdBy\":\"admin_ui\"
    }"
}

for pair in \
  "BABA baba.v1" \
  "DIRS dirs.v1" \
  "NORS nors.v1" \
  "OE_417 oe_417.v1" \
  "SAR sar.v1"
do
  TYPE="$(echo "$pair" | awk '{print $1}')"
  SCHEMA="$(echo "$pair" | awk '{print $2}')"
  echo "  -> $TYPE ($SCHEMA)"
  OUT="$(post "$TYPE" "$SCHEMA")"
  echo "$OUT" | python3 -m json.tool | head -n 40
done

# --- 8) Smoke reads through emulator ---
echo "==> (8) smoke reads"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=10" | python3 -m json.tool | head -n 80
echo
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 120

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
