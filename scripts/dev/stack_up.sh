#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # zsh history expansion off (prevents #/! weirdness)

cd ~/peakops/my-app
mkdir -p .logs scripts/dev functions_emu/dist

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
ORG_ID="${ORG_ID:-org_001}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"
echo "==> (0) kill ports + old emulators/next"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) ensure functions_emu deps"
if [ ! -f functions_emu/package.json ]; then
  mkdir -p functions_emu
  cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0",
    "esbuild": "^0.21.5"
  }
}
JSON
fi
( cd functions_emu && npm i >/dev/null 2>&1 || true )

echo "==> (2) transpile functions_clean/*.mjs -> functions_emu/dist/*.cjs"
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
  ["exportContractPacketV1.mjs", "exportContractPacketV1.cjs"],
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

echo "==> (3) write functions_emu/index.js"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

function pick(mod) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (typeof mod.default === "function") return mod.default;
  return null;
}
function must(fn, name) {
  if (!fn) throw new Error(`functions_emu: missing handler ${name}`);
  return fn;
}

const getContractsV1 = must(pick(require("./dist/getContractsV1.cjs")), "getContractsV1");
const getContractV1 = must(pick(require("./dist/getContractV1.cjs")), "getContractV1");
const getContractPayloadsV1 = must(pick(require("./dist/getContractPayloadsV1.cjs")), "getContractPayloadsV1");
const writeContractPayloadV1 = must(pick(require("./dist/writeContractPayloadV1.cjs")), "writeContractPayloadV1");
const exportContractPacketV1 = must(pick(require("./dist/exportContractPacketV1.cjs")), "exportContractPacketV1");

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
exports.exportContractPacketV1 = onRequest(exportContractPacketV1);
JS

echo "==> (4) write firebase.emu.json"
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON

echo "==> (5) start emulators"
firebase emulators:start --config firebase.emu.json --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ functions not ready"; tail -n 80 .logs/emulators.log; exit 1; }
echo "✅ functions ok (pid=$EMU_PID)"

echo "==> detect Firestore port (8080 vs 8081)"
FS_PORT=""
for p in 8081 8080; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then FS_PORT="$p"; break; fi
done
[ -n "$FS_PORT" ] || { echo "❌ firestore port not found"; exit 1; }
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

echo "==> (6) seed contract doc"
node - <<NODE
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();
(async ()=>{
  await db.collection("contracts").doc("${CONTRACT_ID}").set({
    orgId: "${ORG_ID}",
    orgid: "${ORG_ID}",
    contractNumber: "CTR-2025-0001",
    status: "ACTIVE",
    type: "MSA",
    customerId: "${CUSTOMER_ID}",
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log("✅ seeded contracts/${CONTRACT_ID}");
})();
NODE

echo "==> (7) seed 5 payload docs"
post () {
  local TYPE="$1"; local SCHEMA="$2";
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"${ORG_ID}\",\"contractId\":\"${CONTRACT_ID}\",\"type\":\"${TYPE}\",\"versionId\":\"${VERSION_ID}\",\"schemaVersion\":\"${SCHEMA}\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 20
}
post "BABA" "baba.v1"
post "DIRS" "dirs.v1"
post "NORS" "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR" "sar.v1"

echo "==> (8) start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 || { echo "❌ next not ready"; tail -n 80 .logs/next.log; exit 1; }
echo "✅ next ok (pid=$NEXT_PID)"

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}/payloads/v1_dirs?orgId=${ORG_ID}"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
