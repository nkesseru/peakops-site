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

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"
PIDFILE="$LOGDIR/pids_keepalive.txt"
: > "$PIDFILE"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
NEXT_ENV="$ROOT/next-app/.env.local"

echo "==> Using:"
echo "  PROJECT_ID=$PROJECT_ID"
echo "  ORG_ID=$ORG_ID"
echo "  INCIDENT_ID=$INCIDENT_ID"
echo "  BASE_URL=$BASE_URL"
echo "  FN_BASE=$FN_BASE"
echo

echo "==> (1) Force Next to proxy to emulator via FN_BASE in next-app/.env.local"
touch "$NEXT_ENV"
grep -v '^FN_BASE=' "$NEXT_ENV" > "$NEXT_ENV.tmp" || true
mv "$NEXT_ENV.tmp" "$NEXT_ENV"
echo "FN_BASE=$FN_BASE" >> "$NEXT_ENV"
echo "✅ wrote FN_BASE to $NEXT_ENV"
echo

echo "==> (2) Kill ports + stray processes"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> (3) Start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID" >> "$PIDFILE"

echo "==> wait for emulator hello (max ~30s)"
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

echo "==> (4) Start Next"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID" >> "$PIDFILE"

echo "==> wait for Next (max ~30s)"
for _ in $(seq 1 120); do
  curl -fsSI "$BASE_URL" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsSI "$BASE_URL" >/dev/null 2>&1 || {
  echo "❌ next not responding"
  tail -n 200 "$LOGDIR/next.log" || true
  exit 1
}
echo "✅ next ready (pid=$NEXT_PID)"
echo

echo "==> (5) Smoke: Next proxy GETs (these were 502)"
echo "-- getWorkflowV1"
curl -fsS "$BASE_URL/api/fn/getWorkflowV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 240; echo
echo "-- getTimelineEvents"
curl -fsS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" | head -c 240; echo
echo "-- getIncidentBundleV1"
curl -fsS "$BASE_URL/api/fn/getIncidentBundleV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 240; echo
echo

echo "==> (6) Seed + read timeline (so banner stops yelling)"
echo "-- POST generateTimelineV1 via Next proxy"
curl -fsS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 80 || true

echo "-- GET getTimelineEvents after generate"
curl -fsS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 120 || true
echo

echo "✅ STACK UP (KEEPING RUNNING)"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
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
