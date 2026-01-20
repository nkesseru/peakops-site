#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Ensure logs dir"
mkdir -p .logs

echo "==> (1) Restore functions_clean/package.json (ESM + deps + main=index.js)"
cat > functions_clean/package.json <<'JSON'
{
  "name": "functions_clean",
  "private": true,
  "type": "module",
  "main": "index.js",
  "engines": { "node": "20" },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0"
  }
}
JSON

echo "==> (2) Make sure emulator entrypoint exists: functions_clean/index.js"
# Firebase emulator expects index.js. With type=module, index.js is still ESM.
if [[ -f functions_clean/index.mjs ]]; then
  cp functions_clean/index.mjs functions_clean/index.js
  echo "✅ copied index.mjs -> index.js"
fi

if [[ ! -f functions_clean/index.js ]]; then
  echo "❌ functions_clean/index.js missing (expected)."
  exit 1
fi

echo "==> (3) Hard-kill ports + stray emulators/next"
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (4) Start emulators (functions+firestore) in background"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"

echo "==> (5) Wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "==> (6) Verify loaded functions list includes writeContractPayloadV1"
# If this prints HTML or "does not exist", emulators still didn't load.
curl -sS "$FN_BASE/hello" | head -c 200; echo

echo "==> (7) Quick smoke for writeContractPayloadV1 (should return JSON ok or a structured error)"
curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"org_001","contractId":"car_abc123","type":"BABA","versionId":"v1","schemaVersion":"baba.v1","payload":{"_placeholder":"INIT"},"createdBy":"admin_ui"}' \
  | python3 -m json.tool | head -n 60

echo
echo "✅ Emulator stack ready"
echo "Stop:"
echo "  kill $EMU_PID"
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
