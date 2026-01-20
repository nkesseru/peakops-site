#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> HARD KILL ghost emulator ports + firebase"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore)"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001 LISTEN"
for i in $(seq 1 200); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> Wait for functions to be LOADED (not just listening)"
for i in $(seq 1 200); do
  if grep -q "Loaded functions definitions from source" "$LOGDIR/emulators.log"; then
    break
  fi
  # If codebase failed, bail early with context
  if grep -q "Failed to load function definition from source" "$LOGDIR/emulators.log"; then
    echo "❌ Functions failed to load. Showing error lines:"
    grep -nE "SyntaxError|ReferenceError|Failed to load function definition from source" "$LOGDIR/emulators.log" | tail -n 80 || true
    echo "STOP: kill $EMU_PID"
    exit 1
  fi
  sleep 0.25
done

echo
echo "==> Prove hello"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 160; echo || true

echo
echo "==> Export packet DIRECT emulator (expect ok:true)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 320; echo || true

echo
echo "==> Export packet via Next proxy (expect ok:true)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 320; echo || true

echo
echo "==> packet meta (should NOT be null)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true

echo
echo "==> zip/lock truth"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 60 || true
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true

echo
echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"

echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo
echo "STOP:"
echo "  kill $EMU_PID"
