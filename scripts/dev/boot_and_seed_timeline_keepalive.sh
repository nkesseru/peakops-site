#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
BASE_URL="${4:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Run from repo root (contains next-app/). Current: $ROOT"
  exit 1
fi

mkdir -p .logs
PIDFILE=".logs/pids_timeline_keepalive.txt"
: > "$PIDFILE"

echo "==> kill ports (clean slate)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID" >> "$PIDFILE"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for emulator hello"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null || { echo "❌ hello not up"; tail -n 120 .logs/emulators.log; exit 1; }
echo "✅ emulators ready (pid=$EMU_PID)"

echo
echo "==> confirm generateTimelineV1 is registered"
if rg -n "generateTimelineV1" .logs/emulators.log >/dev/null 2>&1; then
  rg -n "generateTimelineV1" .logs/emulators.log | tail -n 5
else
  echo "❌ generateTimelineV1 not found in emulator log."
  echo "   Tail emulators log:"
  tail -n 180 .logs/emulators.log
  echo
  echo "   Quick check: functions_clean/index.js must export generateTimelineV1."
  exit 1
fi

echo
echo "==> start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID" >> "$PIDFILE"

sleep 2
curl -fsSI "$BASE_URL" | head -n 5 >/dev/null || { echo "❌ next not up"; tail -n 120 .logs/next.log; exit 1; }
echo "✅ next ready (pid=$NEXT_PID)"

echo
echo "==> POST generateTimelineV1 via Next proxy"
curl -sS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 120

echo
echo "==> GET getTimelineEvents (expect count > 0)"
curl -sS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
  | python3 -m json.tool | head -n 200

echo
echo "==> OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "==> LOGS:"
echo "  tail -n 200 .logs/emulators.log"
echo "  tail -n 200 .logs/next.log"
echo
echo "==> STOP (when you want):"
echo "  cat $PIDFILE"
echo "  kill $EMU_PID $NEXT_PID"
echo
echo "✅ STACK UP (KEEPING RUNNING)"
