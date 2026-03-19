#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # stop zsh history expansion from breaking "#"

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> (0) kill ports + stray processes"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) ensure functions_emu exists + deps"
mkdir -p functions_emu/dist
if [ ! -f functions_emu/package.json ]; then
  cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "engines": { "node": ">=22" },
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0"
  },
  "devDependencies": {
    "esbuild": "^0.25.0"
  }
}
JSON
fi
( cd functions_emu && pnpm install --silent )

echo "==> (2) bundle functions_clean/*.mjs -> functions_emu/dist/*.cjs"
node - <<'NODE'
const path = require("path");
const fs = require("fs");
const esbuild = require("./functions_emu/node_modules/esbuild");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

const files = [
  ["getContractsV1.mjs",         "getContractsV1.cjs"],
  ["getContractV1.mjs",          "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs",  "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs", "writeContractPayloadV1.cjs"],
  ["exportContractPacketV1.mjs", "exportContractPacketV1.cjs"],
];

for (const [src, out] of files) {
  const inFile = path.join(SRC, src);
  if (!fs.existsSync(inFile)) {
    console.error("❌ missing:", inFile);
    process.exit(1);
  }
  esbuild.buildSync({
    entryPoints: [inFile],
    outfile: path.join(OUT, out),
    platform: "node",
    format: "cjs",
    bundle: true,
    sourcemap: false,
    logLevel: "silent",
  });
}
console.log("✅ bundled:", files.map(x => x[1]).join(", "));
NODE

echo "==> (3) write functions_emu/index.js"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
function load(p){ const m=require(p); return m?.default || m; }

const getContractsV1         = load("./dist/getContractsV1.cjs");
const getContractV1          = load("./dist/getContractV1.cjs");
const getContractPayloadsV1  = load("./dist/getContractPayloadsV1.cjs");
const writeContractPayloadV1 = load("./dist/writeContractPayloadV1.cjs");
const exportContractPacketV1 = load("./dist/exportContractPacketV1.cjs");

exports.hello = onRequest((req,res)=>res.json({ ok:true, msg:"hello from functions_emu" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
exports.exportContractPacketV1 = onRequest(exportContractPacketV1);
JS

echo "==> (4) firebase.emu.json points to functions_emu"
cat > firebase.emu.json <<JSON
{
  "functions": { "source": "functions_emu", "runtime": "nodejs22" },
  "firestore": { "rules": "firestore.rules" }
}
JSON

echo "==> (5) start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" --config firebase.emu.json > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ functions not ready"; tail -n 120 .logs/emulators.log; exit 1; }
echo "✅ functions ready (pid=$EMU_PID)  FN_BASE=$FN_BASE"

# Firestore port detect (8080 vs 8081)
FS_PORT=""
for p in 8081 8080; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then FS_PORT="$p"; break; fi
done
[ -n "$FS_PORT" ] || { echo "❌ firestore port not found"; exit 1; }
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

echo "==> (6) seed contract + payloads (optional but keeps UI happy)"
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
})().catch(e=>{ console.error(e); process.exit(1); });
NODE

post() {
  local TYPE="$1"
  local SCHEMA="$2"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
  | python3 -m json.tool >/dev/null
}
post "BABA" "baba.v1"
post "DIRS" "dirs.v1"
post "NORS" "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"  "sar.v1"
echo "✅ payloads seeded"

echo "==> (7) point Next at emulator + start Next"
ENVF="next-app/.env.local"
mkdir -p next-app
grep -v '^FN_BASE=' "$ENVF" 2>/dev/null > /tmp/envlocal.tmp || true
mv /tmp/envlocal.tmp "$ENVF"
echo "FN_BASE=$FN_BASE" >> "$ENVF"
echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID" >> "$ENVF"

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 || { echo "❌ next not ready"; tail -n 120 .logs/next.log; exit 1; }
echo "✅ next ready (pid=$NEXT_PID)"

echo
echo "==> SMOKE"
curl -fsS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | head -c 160; echo
curl -fsS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 160; echo

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
