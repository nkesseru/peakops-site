#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"

echo "==> hard kill ports + stray procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

mkdir -p .logs

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for emulators ready (max 60s)"
for i in $(seq 1 120); do
  if grep -q "All emulators ready" .logs/emulators.log; then
    echo "✅ emulators ready"
    break
  fi
  sleep 0.5
done

echo
echo "==> show FIRST real error (if any)"
grep -nE "Failed to load function definition|could not be analyzed|Cannot find module|SyntaxError|Error:" .logs/emulators.log | head -n 30 || true

echo
echo "==> show registered http functions"
grep -n "http function initialized" .logs/emulators.log | tail -n 60 || true

echo
echo "==> curl hello (should be 200, not 404)"
FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"
set +e
curl -i "$FN_BASE/hello" | head -n 25
RC=$?
set -e

echo
if [ $RC -ne 0 ]; then
  echo "❌ curl failed (exit $RC)"
fi

echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo
echo "STOP:"
echo "  kill $EMU_PID"
