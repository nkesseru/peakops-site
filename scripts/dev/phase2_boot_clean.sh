#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

LOGDIR="$(pwd)/.logs"
mkdir -p "$LOGDIR"

echo "==> Phase2 clean boot"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID"
echo

echo "==> kill dev listeners (safe)"
ports="3000 5001 8080 8081 4400 4409 9150"
for p in $ports; do
  ids="$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    kill -9 $ids 2>/dev/null || true
  fi
done

pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> start emulators (functions_clean)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

echo "==> wait for /hello"
for i in $(seq 1 160); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 120 "$LOGDIR/emulators.log" || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi

echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!

echo "==> wait for Next :3000"
for i in $(seq 1 160); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ Next never became ready"
  tail -n 120 "$LOGDIR/next.log" || true
  echo "Stop: kill $EMU_PID $NEXT_PID"
  exit 1
fi

echo
echo "==> smoke (direct) getWorkflowV1"
curl -sS "$FN_BASE/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo
echo
echo "==> smoke (via Next) getWorkflowV1"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo

echo
echo "✅ OPEN:"
echo "  http://localhost:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
