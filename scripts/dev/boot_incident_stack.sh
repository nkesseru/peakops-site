#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> hard kill ports + stray dev/emulator procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "   emu pid: $EMU_PID"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for hello (max ~30s)"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 120 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulator ready"

echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

echo "==> smoke key routes"
BASE_URL="http://127.0.0.1:3000"
INC_URL="$BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
curl -fsS "$INC_URL" >/dev/null || { echo "❌ incidents page 500"; tail -n 160 "$LOGDIR/next.log"; exit 1; }
echo "✅ incidents page ok"
curl -fsS "$BASE_URL/api/fn/getWorkflowV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo
curl -fsS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" | head -c 220; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $INC_URL"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
