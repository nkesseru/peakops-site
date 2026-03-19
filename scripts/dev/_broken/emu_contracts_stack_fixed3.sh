#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

# Usage:
#   bash scripts/dev/emu_contracts_stack_fixed3.sh car_abc123 cust_acme_001 v1 org_001 peakops-pilot
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
ORG_ID="${4:-org_001}"
PROJECT_ID="${5:-peakops-pilot}"

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"

mkdir -p .logs

echo "==> (0) hard-kill stray listeners + emulators + next"
lsof -tiTCP:3000,5001,8081,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.5

echo "==> (1) ensure functions_emu scaffold (CJS entrypoint)"
mkdir -p functions_emu/dist

# minimal package.json (CJS)
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.5"
  }
}
JSON

# install deps locally (avoid pnpm workspace errors)
( cd functions_emu && npm i --silent )

echo "==> (2) transpile ESM handlers from functions_clean -> functions_emu/dist/*.cjs"
node - <<'NODE'
const { buildSync } = require("./functions_emu/node_modules/esbuild");
const path = require("path");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

const files = [
  ["getContractsV1.mjs",        "getContractsV1.cjs"],
  ["getContractV1.mjs",         "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs","writeContractPayloadV1.cjs"],
];

for (const [src, out] of files) {
  buildSync({
    entryPoints: [path.join(SRC, src)],
    outfile: path.join(OUT, out),
    platform: "node",
    format: "cjs",
    bundle: true,
    sourcemap: false,
    logLevel: "silent",
  });
}

console.log("✅ transpiled:", files.map(x => x[1]).join(", "));
NODE

echo "==> (3) write functions_emu/index.js (CJS exports the emulator can load)"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

// CJS bundles produced by esbuild
const { getContractsV1 }        = require("./dist/getContractsV1.cjs");
const { getContractV1 }         = require("./dist/getContractV1.cjs");
const { getContractPayloadsV1 } = require("./dist/getContractPayloadsV1.cjs");
const { writeContractPayloadV1 }= require("./dist/writeContractPayloadV1.cjs");

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1        = onRequest(getContractsV1);
exports.getContractV1         = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1= onRequest(writeContractPayloadV1);
JS
echo "✅ wrote functions_emu/index.js"

echo "==> (4) write firebase.emu.json (functions source = functions_emu)"
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu" }
}
JSON
echo "✅ wrote firebase.emu.json"

echo "==> (5) start emulators (functions + firestore) using firebase.emu.json"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

# Wait for Firestore port
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 8081 >/dev/null 2>&1; then break; fi
  sleep 0.25
done

FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"

# Wait for /hello
for i in $(seq 1 160); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions /hello never became ready"
  tail -n 160 .logs/emulators.log || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi
echo "✅ emulators ok (pid=$EMU_PID)  FN_BASE=$FN_BASE"

echo "==> (6) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 160); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ Next never came up"
  tail -n 120 .logs/next.log || true
  echo "Stop: kill $EMU_PID $NEXT_PID"
  exit 1
fi
echo "✅ next ok (pid=$NEXT_PID)"

echo "==> (7) seed contract doc into Firestore EMULATOR"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
node - <<NODE
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();

(async () => {
  await db.collection("contracts").doc("${CONTRACT_ID}").set({
    orgId: "${ORG_ID}",
    contractNumber: "CTR-2025-0001",
    status: "ACTIVE",
    type: "MSA",
    customerId: "${CUSTOMER_ID}",
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
})();
NODE

echo "==> (8) seed 5 payload docs via emulator function writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local RESP STATUS BODY
  RESP="$(curl -sS -w $'\n__HTTP_STATUS__:%{http_code}' -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}")"
  BODY="${RESP%$'\n__HTTP_STATUS__:'*}"
  STATUS="${RESP##*__HTTP_STATUS__:}"
  if [[ "$STATUS" != "200" ]]; then
    echo "❌ writeContractPayloadV1 HTTP $STATUS ($TYPE)"
    echo "$BODY" | head -c 400; echo
    exit 1
  fi
  echo "$BODY" | python3 -m json.tool >/dev/null 2>&1 || { echo "❌ non-json body"; echo "$BODY" | head -c 400; echo; exit 1; }
  echo "✅ $TYPE seeded"
}

post "BABA" "baba.v1"
post "DIRS" "dirs.v1"
post "NORS" "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"  "sar.v1"

echo
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
