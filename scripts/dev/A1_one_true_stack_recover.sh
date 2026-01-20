#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # disable zsh history expansion if this runs under zsh

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

# If user accidentally passed NEXT_PORT first (numeric), swap
if [[ "$PROJECT_ID" =~ ^[0-9]+$ ]]; then
  echo "⚠️ PROJECT_ID looks numeric ($PROJECT_ID). Swapping args."
  NEXT_PORT="$PROJECT_ID"
  PROJECT_ID="${1:-peakops-pilot}" # not used, but keep sane
  PROJECT_ID="${2:-peakops-pilot}"
  ORG_ID="${3:-org_001}"
  INCIDENT_ID="${4:-inc_TEST}"
fi

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> A1 One True Stack Recover"
echo "repo=$ROOT"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> HARD KILL ghost emulator ports + firebase"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924 8937; do
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

echo "==> Wait for functions LOADED (not just listening)"
for i in $(seq 1 200); do
  if rg -n "Loaded functions definitions from source:" "$LOGDIR/emulators.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "==> Prove hello (direct emulator)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 200; echo || true
echo

echo "==> Seed incident doc into Firestore emulator (PATCH + updateMask) — quoted URL so () doesn't explode"
PATCH_URL="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime"
curl -sS -X PATCH "$PATCH_URL" \
  -H "Content-Type: application/json" \
  -d "$(python3 - <<PY
import json
print(json.dumps({
  "fields": {
    "orgId": {"stringValue": "$ORG_ID"},
    "title": {"stringValue": f"Seed Incident $INCIDENT_ID"},
    "startTime": {"stringValue": "2026-01-01T00:00:00.000Z"},
  }
}))
PY
)" | head -c 240; echo
echo

echo "==> Verify Firestore has incident"
curl -sS "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" | head -c 240; echo
echo

echo "==> Start Next (clean cache)"
rm -rf next-app/.next 2>/dev/null || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port "$NEXT_PORT" > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next"
for i in $(seq 1 200); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 6 || true
echo

echo "==> Smoke: workflow"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo || true
echo

echo "==> Smoke: export (force=1) via Next proxy"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 260; echo || true
echo

echo "==> Smoke: packetMeta"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo

echo "==> Smoke: packet zip HEAD"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -n 25 || true
echo

echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
