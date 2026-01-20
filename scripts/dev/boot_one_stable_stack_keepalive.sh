#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------
# ONE STABLE STACK (keepalive)
#
# Does:
#  1) Start emulators
#  2) Wait for /hello
#  3) Start Next
#  4) Wait for /
#  5) Seed incident baseline (title/startTime/orgId)
#  6) Seed timeline (POST generateTimelineV1)
#  7) Leave everything running
#
# Usage:
#   bash scripts/dev/boot_one_stable_stack_keepalive.sh [projectId] [orgId] [incidentId] [baseUrl]
#
# Example:
#   bash scripts/dev/boot_one_stable_stack_keepalive.sh peakops-pilot org_001 inc_TEST http://127.0.0.1:3000
# -------------------------------------------------------

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
BASE_URL="${4:-http://127.0.0.1:3000}"

# Find repo root (must contain next-app/)
ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do
  ROOT="$(dirname "$ROOT")"
done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Run this from inside the repo (somewhere under a folder containing next-app/)"
  echo "   Current: $(pwd)"
  exit 1
fi
cd "$ROOT"

LOGDIR="$ROOT/.logs"
PIDFILE="$LOGDIR/pids_stable_stack.txt"
mkdir -p "$LOGDIR"
: > "$PIDFILE"

echo "==> ROOT=$ROOT"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID BASE_URL=$BASE_URL"
echo

# -------------------------------------------------------
# 0) Clean slate (ports + stray procs)
# -------------------------------------------------------
echo "==> kill ports + old procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

# -------------------------------------------------------
# 1) Start emulators
# -------------------------------------------------------
echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID" | tee -a "$PIDFILE"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

# Detect firestore REST port (8080 vs 8081)
FIRESTORE_REST="http://127.0.0.1:8081"
for _ in $(seq 1 40); do
  curl -fsS "$FIRESTORE_REST" >/dev/null 2>&1 && break
  sleep 0.15
done
if ! curl -fsS "$FIRESTORE_REST" >/dev/null 2>&1; then
  FIRESTORE_REST="http://127.0.0.1:8080"
fi

echo "==> wait for emulator /hello (max ~30s)"
for _ in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulator hello not responding"
  tail -n 200 "$LOGDIR/emulators.log" || true
  exit 1
}
echo "✅ emulators ready"
echo "✅ FIRESTORE_REST=$FIRESTORE_REST"
echo

# -------------------------------------------------------
# 2) Start Next
# -------------------------------------------------------
echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID" | tee -a "$PIDFILE"

echo "==> wait for Next / (max ~30s)"
for _ in $(seq 1 120); do
  curl -fsSI "$BASE_URL" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsSI "$BASE_URL" >/dev/null 2>&1 || {
  echo "❌ Next not responding"
  tail -n 220 "$LOGDIR/next.log" || true
  exit 1
}
echo "✅ Next ready"
echo

# -------------------------------------------------------
# 3) Seed incident baseline
# -------------------------------------------------------
echo "==> seed incident baseline (title/startTime/orgId) via Firestore REST emulator"
NOW_UTC="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
DOC_PATH="projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}"

curl -sS -X PATCH \
  "${FIRESTORE_REST}/v1/${DOC_PATH}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime&updateMask.fieldPaths=createdAt&updateMask.fieldPaths=updatedAt" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\":     {\"stringValue\": \"${ORG_ID}\"},
      \"title\":     {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW_UTC="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
DOC_PATH="projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}"

curl -sS -X PATCH \
  "${FIRESTORE_REST}/v1/${DOC_PATH}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime&updateMask.fieldPaths=createdAt&updateMask.fieldPaths=updatedAt" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\":     {\"stringValue\": \"${ORG_ID}\"},
      \"title\":     {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW_UTC}\"},
      \"createdAt\": {\"timestampValue\": \"${NOW_UTC}\"},
      \"updatedAt\": {\"timestampValue\": \"${NOW_UTC}\"}
    }
  }" >/dev/null

echo "✅ incident seeded: incidents/${INCIDENT_ID}"
echo

# -------------------------------------------------------
# 4) Seed timeline
# -------------------------------------------------------
echo "==> seed timeline (POST /api/fn/generateTimelineV1)"
curl -sS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"stable_keepalive\"}" \
| (command -v python3 >/dev/null && python3 -m json.tool | head -n 120 || cat)

echo
echo "==> verify timeline reads (GET /api/fn/getTimelineEvents)"
curl -sS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| (command -v python3 >/dev/null && python3 -m json.tool | head -n 200 || cat)

echo
echo "✅ STACK UP (LEAVING RUNNING)"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
echo "  tail -n 200 $LOGDIR/next.log"
echo
echo "PIDS (saved to $PIDFILE):"
cat "$PIDFILE"
echo
echo "STOP (only when ready):"
echo "  kill $EMU_PID $NEXT_PID"
echo
echo "NOTE: leave this terminal alone to keep the stack running."
