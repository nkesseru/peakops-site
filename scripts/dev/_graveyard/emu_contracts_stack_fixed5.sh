#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app
mkdir -p .logs

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"

echo "==> (0) hard-kill stray listeners + emulators + next"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) ensure firebase.emu.json uses functions_emu + nodejs22"
cat > firebase.emu.json <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON

echo "==> (2) ensure functions_emu deps"
mkdir -p functions_emu
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0",
    "esbuild": "^0.25.0"
  }
}
JSON
( cd functions_emu && npm i --silent ) >/dev/null

echo "==> (3) transpile handlers (ESM -> CJS) into functions_emu/dist"
mkdir -p functions_emu/dist
node - <<'NODE'
const path = require("path");
const esbuild = require("./functions_emu/node_modules/esbuild");
const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

const files = [
  ["getContractsV1.mjs", "getContractsV1.cjs"],
  ["getContractV1.mjs", "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs", "writeContractPayloadV1.cjs"],
];

for (const [src, out] of files) {
  esbuild.buildSync({
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

echo "==> (4) write functions_emu/index.js (IMPORTANT: initializeApp BEFORE using Firestore)"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");

// ✅ must init admin SDK once (emulator uses FIRESTORE_EMULATOR_HOST automatically)
if (!getApps().length) initializeApp();

const getContractsV1 = require("./dist/getContractsV1.cjs");
const getContractV1 = require("./dist/getContractV1.cjs");
const getContractPayloadsV1 = require("./dist/getContractPayloadsV1.cjs");
const writeContractPayloadV1 = require("./dist/writeContractPayloadV1.cjs");

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
JS

echo "==> (5) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" --config firebase.emu.json > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

echo "==> detect Firestore emulator port (8080 vs 8081)"
FS_PORT=""
for p in 8080 8081; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then FS_PORT="$p"; break; fi
done
if [[ -z "$FS_PORT" ]]; then
  echo "❌ could not find firestore emulator port"; exit 1
fi
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

echo "==> (6) seed contract doc into Firestore emulator"
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

echo "==> (7) seed 5 payload docs via emulator function writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  echo "   -> $TYPE ($SCHEMA)"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 30
}
post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

echo "==> (8) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "==> SMOKE (Next proxy)"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 40
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 40
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60

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
