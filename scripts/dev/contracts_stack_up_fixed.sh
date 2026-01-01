#!/usr/bin/env bash
set -euo pipefail

# Avoid zsh history expansion issues when you paste commands with !
set +H 2>/dev/null || true

cd ~/peakops/my-app
mkdir -p .logs scripts/dev

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID org=$ORG_ID project=$PROJECT_ID"

echo "==> (0) hard-kill stray listeners + emulators + next"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.4

echo "==> (1) rebuild functions_emu scaffold"
rm -rf functions_emu
mkdir -p functions_emu/dist

# Keep emulator deps local to functions_emu (no workspace-root flags)
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "type": "commonjs",
  "engines": { "node": ">=22" },
  "dependencies": {
    "cors": "^2.8.5",
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.5"
  }
}
JSON

pushd functions_emu >/dev/null
npm i --silent
popd >/dev/null

echo "==> (2) transpile functions_clean/*.mjs -> functions_emu/dist/*.cjs"
node - <<'NODE'
const path = require("path");
const fs = require("fs");
const esbuild = require("./functions_emu/node_modules/esbuild");

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
  const inFile = path.join(SRC, src);
  if (!fs.existsSync(inFile)) {
    console.error("Missing:", inFile);
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
console.log("✅ transpiled:", files.map(x => x[1]).join(", "));
NODE

echo "==> (3) write functions_emu/index.js (robust handler resolver)"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

function pickHandler(mod, preferredName) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;

  // common esbuild patterns
  if (typeof mod.default === "function") return mod.default;
  if (preferredName && typeof mod[preferredName] === "function") return mod[preferredName];

  // try any exported function
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") return mod[k];
  }
  return null;
}

function must(name, mod, preferred) {
  const h = pickHandler(mod, preferred);
  if (!h) {
    const keys = mod ? Object.keys(mod) : [];
    throw new Error(`functions_emu index.js: could not resolve handler for ${name} (keys=${keys.join(",")})`);
  }
  return h;
}

const getContractsMod        = require("./dist/getContractsV1.cjs");
const getContractMod         = require("./dist/getContractV1.cjs");
const getContractPayloadsMod = require("./dist/getContractPayloadsV1.cjs");
const writePayloadMod        = require("./dist/writeContractPayloadV1.cjs");

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1        = onRequest(must("getContractsV1",        getContractsMod,        "getContractsV1"));
exports.getContractV1         = onRequest(must("getContractV1",         getContractMod,         "getContractV1"));
exports.getContractPayloadsV1 = onRequest(must("getContractPayloadsV1", getContractPayloadsMod, "getContractPayloadsV1"));
exports.writeContractPayloadV1= onRequest(must("writeContractPayloadV1",writePayloadMod,        "writeContractPayloadV1"));
JS

echo "==> (4) write firebase.emu.json (functions source = functions_emu + runtime)"
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON

echo "==> (5) start emulators (functions + firestore)"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)  FN_BASE=$FN_BASE"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 140 .logs/emulators.log || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi

echo "==> detect Firestore emulator port (8080 vs 8081)"
FS_PORT=""
for p in 8080 8081; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then FS_PORT="$p"; break; fi
done
if [ -z "$FS_PORT" ]; then
  echo "❌ Could not find firestore emulator port (8080/8081)"
  lsof -iTCP -sTCP:LISTEN | rg "8080|8081" || true
  exit 1
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

echo "==> (7) seed 5 payload docs via emulator writeContractPayloadV1"
post() {
  local TYPE="$1"
  local SCHEMA="$2"
  echo "   -> $TYPE ($SCHEMA)"
  local BODY
  BODY="$(curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}")"
  echo "$BODY" | python3 -m json.tool | head -n 40
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
    echo "✅ next up (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

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
