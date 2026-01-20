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

echo "==> A1 v3 One True Stack (project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT)"
echo

echo "==> HARD KILL ghost ports + firebase + Next"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924 3000; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore) [single instance]"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001 + functions LOADED"
for i in $(seq 1 300); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 || { sleep 0.25; continue; }
  if grep -q "Loaded functions definitions from source" "$LOGDIR/emulators.log"; then break; fi
  if grep -q "Failed to load function definition from source" "$LOGDIR/emulators.log"; then
    echo "❌ Functions failed to load. Key errors:"
    grep -nE "SyntaxError|ReferenceError|Failed to load function definition from source" "$LOGDIR/emulators.log" | tail -n 120 || true
    echo "STOP: kill $EMU_PID"
    exit 1
  fi
  sleep 0.25
done

echo
echo "==> Prove hello"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 120; echo || true

echo
echo "==> Seed incident doc (CREATE first; if exists then PATCH)"
BASE="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents"
CREATE_URL="${BASE}/incidents?documentId=${INCIDENT_ID}"
DOC_URL="${BASE}/incidents/${INCIDENT_ID}"

BODY="$(cat <<JSON
{
  "fields": {
    "orgId": {"stringValue": "${ORG_ID}"},
    "title": {"stringValue": "Seed Incident ${INCIDENT_ID}"},
    "startTime": {"stringValue": "2026-01-01T00:00:00.000Z"}
  }
}
JSON
)"

# Try CREATE
CODE="$(curl -sS -o "$LOGDIR/seed_create.out" -w "%{http_code}" \
  -X POST "$CREATE_URL" -H "Content-Type: application/json" --data "$BODY" || true)"

if [[ "$CODE" == "200" ]]; then
  echo "✅ created incident doc"
elif [[ "$CODE" == "409" ]]; then
  echo "ℹ️ incident already exists (409) -> patch"
  curl -sS -o "$LOGDIR/seed_patch.out" \
    -X PATCH "$DOC_URL" -H "Content-Type: application/json" --data "$BODY" || true
  echo "✅ patched incident doc"
else
  echo "❌ seed CREATE failed (http=$CODE)"
  head -c 600 "$LOGDIR/seed_create.out"; echo
  echo "STOP: kill $EMU_PID"
  exit 1
fi

echo
echo "==> Confirm incident exists (GET)"
curl -sS "$DOC_URL" | head -c 260; echo || true

echo
echo "==> Start Next (clean cache)"
rm -rf next-app/.next 2>/dev/null || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port "$NEXT_PORT" > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next"
for i in $(seq 1 300); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 6 || true

echo
echo "==> Export packet (force=1) via Next proxy"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 260; echo || true

echo
echo "==> packetMeta"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true

echo
echo "==> lock"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true

echo
echo "==> zip (may be null until Verify ZIP)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true

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
