#!/usr/bin/env bash
set -euo pipefail

# Boot + keep alive for demo dev.
# - Starts emulators + next
# - Seeds timeline (POST generateTimelineV1)
# - Verifies timeline read (getTimelineEvents)
# - Prints OPEN links + STOP command
#
# Usage:
#   bash scripts/dev/boot_demo_stack_keepalive.sh [PROJECT_ID] [ORG_ID] [INCIDENT_ID] [BASE_URL]
#
# Example:
#   bash scripts/dev/boot_demo_stack_keepalive.sh peakops-pilot org_001 inc_TEST http://127.0.0.1:3000

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
BASE_URL="${4:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Run from repo root (contains next-app/). Current: $ROOT"
  exit 1
fi

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
TS="$(date +%Y%m%d_%H%M%S)"
PIDFILE="$LOGDIR/pids_${TS}.txt"

echo "==> Using:"
echo "  PROJECT_ID=$PROJECT_ID"
echo "  ORG_ID=$ORG_ID"
echo "  INCIDENT_ID=$INCIDENT_ID"
echo "  BASE_URL=$BASE_URL"
echo "  FN_BASE=$FN_BASE"
echo "  LOGDIR=$LOGDIR"
echo

echo "==> kill ports (safe for dev)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID" > "$PIDFILE"

echo "==> wait for hello (max ~30s)"
for _ in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulator hello not responding"
  tail -n 160 "$LOGDIR/emulators.log" || true
  exit 1
}
echo "✅ emulator ready (pid=$EMU_PID)"
echo

echo "==> start next (port 3000)"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID" >> "$PIDFILE"

sleep 2
curl -fsSI "$BASE_URL" | head -n 6 >/dev/null || {
  echo "❌ next not responding"
  tail -n 160 "$LOGDIR/next.log" || true
  exit 1
}
echo "✅ next ready (pid=$NEXT_PID)"
echo

echo "==> seed timeline (POST generateTimelineV1)"
curl -sS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 80 || true
echo

echo "==> verify timeline read (GET getTimelineEvents)"
curl -sS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 120 || true
echo

echo "✅ STACK UP (KEEPING RUNNING)"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
echo "  tail -n 200 $LOGDIR/next.log"
echo
echo "PIDS:"
cat "$PIDFILE"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
echo
echo "NOTE:"
echo "  This script keeps both servers running. Don't run another boot script unless you stop these first."
