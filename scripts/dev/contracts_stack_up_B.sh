#!/usr/bin/env bash
set -euo pipefail

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"
ORG_ID="${ORG_ID:-org_001}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"

ROOT="$(pwd)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"

# ---------------------------
# (0) Kill ports + stray
# ---------------------------
echo "==> (0) kill ports + old emulators/next"
for p in 3000 5001 8080 8081 4400 4401 4409 4500 4501 4509 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# ---------------------------
# (1) Build functions_emu scaffold (CJS)
# ---------------------------
echo "==> (1) build functions_emu scaffold"
rm -rf "$ROOT/functions_emu"
mkdir -p "$ROOT/functions_emu/dist"

cat > "$ROOT/functions_emu/package.json" <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "engines": { "node": "22" }
}
JSON

# install deps locally inside functions_emu (NOT workspace root)
cd "$ROOT/functions_emu"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ pnpm not found. Install pnpm first."
  exit 1
fi

pnpm add firebase-functions firebase-admin >/dev/null
pnpm add -D esbuild >/dev/null
cd "$ROOT"

# ---------------------------
# (2) Bundle selected functions_clean handlers -> functions_emu/dist/*.cjs
# ---------------------------
echo "==> (2) bundle handlers (CJS) including exportContractPacketV1"
ESBUILD="$ROOT/functions_emu/node_modules/.bin/esbuild"

bundle_one() {
  local src="$1"
  local out="$2"
  if [[ ! -f "$ROOT/functions_clean/$src" ]]; then
    echo "❌ missing: functions_clean/$src"
    exit 1
  fi
  "$ESBUILD" "$ROOT/functions_clean/$src" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node22 \
    --outfile="$ROOT/functions_emu/dist/$out" \
    --external:firebase-admin \
    --external:firebase-functions \
    --external:firebase-functions/* \
    >/dev/null
  echo "✅ bundled: $src -> dist/$out"
}

bundle_one "getContractsV1.mjs" "getContractsV1.cjs"
bundle_one "getContractV1.mjs" "getContractV1.cjs"
bundle_one "getContractPayloadsV1.mjs" "getContractPayloadsV1.cjs"
bundle_one "writeContractPayloadV1.mjs" "writeContractPayloadV1.cjs"
bundle_one "exportContractPacketV1.mjs" "exportContractPacketV1.cjs"

# ---------------------------
# (3) Write functions_emu/index.js
# ---------------------------
echo "==> (3) write functions_emu/index.js"
cat > "$ROOT/functions_emu/index.js" <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (!getApps().length) initializeApp();

function pick(mod, name) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (mod.default && typeof mod.default === "function") return mod.default;
  if (name && typeof mod[name] === "function") return mod[name];
  if (mod.handler && typeof mod.handler === "function") return mod.handler;
  return null;
}

const mGetContractsV1 = require("./dist/getContractsV1.cjs");
const mGetContractV1 = require("./dist/getContractV1.cjs");
const mGetContractPayloadsV1 = require("./dist/getContractPayloadsV1.cjs");
const mWriteContractPayloadV1 = require("./dist/writeContractPayloadV1.cjs");
const mExportContractPacketV1 = require("./dist/exportContractPacketV1.cjs");

const getContractsV1 = pick(mGetContractsV1, "getContractsV1");
const getContractV1 = pick(mGetContractV1, "getContractV1");
const getContractPayloadsV1 = pick(mGetContractPayloadsV1, "getContractPayloadsV1");
const writeContractPayloadV1 = pick(mWriteContractPayloadV1, "writeContractPayloadV1");
const exportContractPacketV1 = pick(mExportContractPacketV1, "exportContractPacketV1");

if (![getContractsV1, getContractV1, getContractPayloadsV1, writeContractPayloadV1, exportContractPacketV1].every(Boolean)) {
  throw new Error("functions_emu/index.js: could not resolve one or more handlers");
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
exports.exportContractPacketV1 = onRequest(exportContractPacketV1);
JS

# ---------------------------
# (4) firebase.emu.json
# ---------------------------
echo "==> (4) write firebase.emu.json (functions source=functions_emu)"
cat > "$ROOT/firebase.emu.json" <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON

# ---------------------------
# (5) start emulators
# ---------------------------
echo "==> (5) start emulators"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --config "$ROOT/firebase.emu.json" \
  > "$LOGS/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)  FN_BASE=$FN_BASE"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 80 "$LOGS/emulators.log"
  exit 1
fi

# detect firestore port
FIRESTORE_PORT="8081"
curl -fsS "http://127.0.0.1:8081" >/dev/null 2>&1 || FIRESTORE_PORT="8080"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FIRESTORE_PORT}"
echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

# ---------------------------
# (6) seed contract doc
# ---------------------------
echo "==> (6) seed contract doc"
node - <<NODE
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();
(async () => {
  await db.collection("contracts").doc("${CONTRACT_ID}").set({
    id: "${CONTRACT_ID}",
    orgId: "${ORG_ID}",
    customerId: "${CUSTOMER_ID}",
    contractNumber: "CTR-2025-0001",
    type: "MSA",
    status: "ACTIVE",
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
})();
NODE

# ---------------------------
# (7) seed payload docs via emulator function
# ---------------------------
echo "==> (7) seed payload docs via writeContractPayloadV1"

post() {
  local TYPE="$1"
  local SCHEMA="$2"
  local BODY
  BODY="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}")"
  echo "$BODY" | python3 -m json.tool >/dev/null 2>&1 || {
    echo "❌ non-json response:"
    echo "$BODY" | head -c 400; echo
    exit 1
  }
  echo "$BODY" | python3 -m json.tool | head -n 20
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

# ---------------------------
# (8) start Next
# ---------------------------
echo "==> (8) start Next (port 3000)"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$LOGS/next.log" 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next up (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

# ---------------------------
# (9) smoke: Next proxy routes + B export
# ---------------------------
echo
echo "==> (9) smoke via Next proxy"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 40 || true
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 40 || true
curl -sS "http://127.0.0.1:3000/api/fn/exportContractPacketV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&versionId=$VERSION_ID&limit=200" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "B export (via Next):"
echo "  http://localhost:3000/api/fn/exportContractPacketV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&versionId=$VERSION_ID&limit=200"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
