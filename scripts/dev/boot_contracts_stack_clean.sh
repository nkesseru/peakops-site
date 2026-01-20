#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/${PROJECT_ID}/us-central1}"

mkdir -p .logs

echo "==> (0) kill ports (only ports)"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true

echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (2) wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

echo "==> (3) start Next (port 3000)"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
