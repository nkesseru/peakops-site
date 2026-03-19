#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app
set +H 2>/dev/null || true
mkdir -p .logs

echo "==> (0) Kill stray listeners"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Rewrite functions_emu/index.js (initializeApp BEFORE requiring dist/*)"
mkdir -p functions_emu
cat > functions_emu/index.js <<'JS'
"use strict";

const { onRequest } = require("firebase-functions/v2/https");

// IMPORTANT: initialize Admin BEFORE loading any modules that call getFirestore() at import time
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

// Now it is safe to require bundled handlers
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

echo "==> (2) Start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore \
  --project peakops-pilot \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ hello ok (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

echo "==> (3) Smoke: getContractsV1 (direct)"
curl -sS "$FN_BASE/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 40 || true
echo

echo "==> (4) Smoke: writeContractPayloadV1 (direct)"
curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"org_001","contractId":"car_abc123","type":"DIRS","versionId":"v1","schemaVersion":"dirs.v1","payload":{"_placeholder":"INIT"},"createdBy":"admin_ui"}' \
  | python3 -m json.tool | head -n 60 || true
echo

echo "✅ If (4) returns ok:true, ECONNRESET is dead."
echo "Logs: tail -n 120 .logs/emulators.log"
echo "Stop: kill $EMU_PID"
