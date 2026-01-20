#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
DATA_DIR="${2:-./.emulator_data}"

echo "==> hard stop anything holding emulator ports"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,4409,4500,4501,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

mkdir -p .logs
mkdir -p "$DATA_DIR"

echo "==> start emulators (functions+firestore) with import/export-on-exit"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --import "$DATA_DIR" \
  --export-on-exit "$DATA_DIR" \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for functions hello"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> start next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

echo "==> wait for next"
for i in $(seq 1 160); do
  curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> smoke"
curl -fsS "$FN_BASE/hello" | head -c 120; echo
curl -fsS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 200; echo
curl -fsS "http://127.0.0.1:3000/api/fn/getTimelineEvents?orgId=org_001&incidentId=inc_TEST&limit=50" | head -c 260; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
