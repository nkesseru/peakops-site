#!/usr/bin/env bash
set -euo pipefail

# zsh-safe (in case executed from zsh)
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"
LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> kill anything already on the ports"
lsof -ti tcp:5001 | xargs -r kill -9 || true
lsof -ti tcp:3000 | xargs -r kill -9 || true

echo "==> start Firebase emulators (keepalive)"
(
  cd functions_clean 2>/dev/null || cd functions 2>/dev/null || cd .
  firebase emulators:start --project "$PROJECT_ID" > "../$LOGDIR/emulators.log" 2>&1
) &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> wait for Functions emulator (:5001)"
for i in $(seq 1 80); do
  if curl -sS "http://127.0.0.1:5001/$PROJECT_ID/us-central1/hello" >/dev/null 2>&1; then
    echo "✅ functions ready"
    break
  fi
  # fallback: if /hello doesn't exist, just check port open
  if nc -z 127.0.0.1 5001 >/dev/null 2>&1; then
    echo "✅ functions port open"
    break
  fi
  sleep 0.25
done

echo "==> start Next (keepalive)"
(
  cd next-app
  pnpm dev --port "$NEXT_PORT" > "../$LOGDIR/next.log" 2>&1
) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> wait for Next (/)"
for i in $(seq 1 80); do
  if curl -sS "http://127.0.0.1:$NEXT_PORT/" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  sleep 0.25
done

echo
echo "✅ STACK UP (KEEPALIVE)"
echo "OPEN:  http://127.0.0.1:$NEXT_PORT/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "LOGS:  tail -n 200 $LOGDIR/emulators.log"
echo "       tail -n 200 $LOGDIR/next.log"
echo "STOP:  kill $EMU_PID $NEXT_PID"
echo

# keep script running so background procs are tied to this terminal session
wait
