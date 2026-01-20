#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> (0) Hard-kill stray emulators/next + ports"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Ensure functions_emu has runtime (package.json engines) + deps"
mkdir -p functions_emu
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "type": "commonjs",
  "engines": { "node": "20" },
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0"
  }
}
JSON

# install deps (idempotent)
( cd functions_emu && npm install --silent )

echo "==> (2) Ensure firebase.emu.json declares runtime + source"
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs20" }
}
JSON

echo "==> (3) Start emulators using firebase.emu.json"
mkdir -p .logs
firebase emulators:start --only functions,firestore \
  --project peakops-pilot \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &

EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
echo "==> (4) Wait for /hello: $FN_BASE/hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)"
    echo "Functions: $FN_BASE"
    echo "Firestore: 127.0.0.1:8081"
    echo "Stop: kill $EMU_PID"
    exit 0
  fi
  sleep 0.25
done

echo "❌ functions /hello never became ready"
echo "---- tail .logs/emulators.log ----"
tail -n 120 .logs/emulators.log || true
echo "Stop: kill $EMU_PID"
exit 1
