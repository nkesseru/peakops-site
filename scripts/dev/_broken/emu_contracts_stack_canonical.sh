#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
ORG_ID="${ORG_ID:-org_001}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"
echo "==> kill ports"
lsof -tiTCP:3000,5001,8081,4409,9150 | xargs -r kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> ensure functions_emu deps"
mkdir -p functions_emu
pushd functions_emu >/dev/null
if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi
npm i -D esbuild >/dev/null 2>&1 || npm i -D esbuild
popd >/dev/null

mkdir -p functions_emu
if [ ! -f functions_emu/package.json ]; then
  cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "type": "commonjs",
  "main": "index.js",
  "dependencies": {
    "firebase-functions": "^6.6.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.5"
  }
}
JSON
fi
( cd functions_emu && npm i >/dev/null )

echo "==> transpile functions_clean/*.mjs -> functions_emu/dist/*.cjs"
node - <<'NODE'
const { buildSync } = require("./functions_emu/node_modules/esbuild");
const path = require("path");
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
console.log("✅ transpiled:", files.map(x=>x[1]).join(", "));
NODE

echo "==> write functions_emu/index.js"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

const { getContractsV1 } = require("./dist/getContractsV1.cjs");
const { getContractV1 } = require("./dist/getContractV1.cjs");
const { getContractPayloadsV1 } = require("./dist/getContractPayloadsV1.cjs");
const { writeContractPayloadV1 } = require("./dist/writeContractPayloadV1.cjs");

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
JS

echo "==> write firebase.emu.json (functions source = functions_emu)"
cat > firebase.emu.json <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu" }
}
JSON

echo "==> start emulators (functions+firestore) with config firebase.emu.json"
firebase emulators:start \
  --only functions,firestore \
  --project "$PROJECT_ID" \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for Firestore :8081"
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 8081 >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "==> wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)  FN_BASE=$FN_BASE"
    break
  fi
  sleep 0.25
done

echo "==> start Next (port 3000)"
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo "==> seed Firestore emulator contract doc"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
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
})();
NODE

echo "==> seed 5 payload docs via writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local BODY
  BODY="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}")"
  echo "$BODY" | python3 -m json.tool >/dev/null 2>&1 || { echo "❌ non-json: $BODY"; exit 1; }
  echo "$BODY" | python3 -m json.tool | head -n 30
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

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
