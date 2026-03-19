#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> kill anything already on key ports"
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true

# Best-effort free ports
lsof -tiTCP:${NEXT_PORT} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
lsof -tiTCP:8080 -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true

echo "==> start Firebase emulators (firestore + functions) KEEPALIVE"
firebase emulators:start --only firestore,functions --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> wait for Functions emulator (:5001)"
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 5001 >/dev/null 2>&1; then
    echo "✅ functions port open"
    break
  fi
  sleep 0.25
done

echo "==> wait for Firestore emulator (:8080)"
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 8080 >/dev/null 2>&1; then
    echo "✅ firestore port open"
    break
  fi
  sleep 0.25
done

echo "==> sanity: Firestore REST should respond (may be 404/JSON, but must CONNECT)"
curl -sS "http://127.0.0.1:8080/" >/dev/null || true

echo "==> start Next with emulator env"
rm -rf next-app/.next 2>/dev/null || true
(
  cd next-app
  FIRESTORE_EMULATOR_REST="http://127.0.0.1:8080" \
  pnpm dev --port "$NEXT_PORT" > "../$LOGDIR/next.log" 2>&1
) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> wait for Next (/)"
for i in $(seq 1 120); do
  if curl -sS "http://127.0.0.1:$NEXT_PORT/" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  sleep 0.25
done

echo
echo "✅ STACK UP"
echo "OPEN:  http://127.0.0.1:$NEXT_PORT/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "LOGS:  tail -n 200 $LOGDIR/emulators.log"
echo "       tail -n 200 $LOGDIR/next.log"
echo "STOP:  kill $EMU_PID $NEXT_PID"
echo

wait
