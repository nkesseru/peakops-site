#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> HARD RESET: kill ghost emulators + Next on ${NEXT_PORT}"

# Kill anything listening on known emulator ports + Next port
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924 8937 8990 "${NEXT_PORT}"; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done

# Also kill firebase tools + pnpm dev processes
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore) SINGLE instance"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001 LISTEN"
for i in $(seq 1 200); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> Wait for functions LOADED"
for i in $(seq 1 200); do
  if rg -n "Loaded functions definitions from source:" "$LOGDIR/emulators.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "==> Prove hello"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 120; echo || true
echo

echo "==> Start Next (clean cache) on ${NEXT_PORT}"
rm -rf next-app/.next 2>/dev/null || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port "$NEXT_PORT" > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next"
for i in $(seq 1 240); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 6 || true

echo
echo "==> Quick health checks"
echo "-- next workflow route:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 180; echo || true
echo "-- packet zip head:"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" | head -n 12 || true

echo
echo "OPEN:"
echo "  http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST?orgId=org_001"
echo "  http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST/bundle?orgId=org_001"

echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"

echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
