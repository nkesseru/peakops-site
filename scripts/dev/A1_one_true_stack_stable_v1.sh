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

echo "==> A1 stable stack"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> HARD KILL ghost ports + firebase + next"
for p in 3000 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore) [single instance]"
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
  grep -q "Loaded functions definitions from source" "$LOGDIR/emulators.log" && break
  sleep 0.25
done

echo
echo "==> Prove hello (direct emulator)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 160; echo || true

echo
echo "==> Seed incident doc (Firestore emulator REST)"
# Create or patch doc deterministically
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"2026-01-01T00:00:00.000Z\"}
    }
  }" | head -c 220; echo

echo "==> Confirm incident exists (GET)"
curl -sS \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  | head -c 220; echo

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

echo "==> Smoke: workflow (should be 200 JSON)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -n 18 || true
echo

echo "==> Smoke: export (force=1) (should be ok:true)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 260; echo || true
echo

echo "==> Smoke: packetMeta (should NOT be null)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo

echo "==> Smoke: packet zip HEAD (should be 200 + headers)"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -n 30 || true
echo

echo "==> Persist ZIP verification from headers (best-effort)"
ZIP_SHA="$(curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-zip-sha256"{print $2}')"
ZIP_SIZE="$(curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-zip-size"{print $2}')"
ZIP_GEN="$(curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-generatedat"{print $2}')"

if [[ -n "${ZIP_SHA}" && -n "${ZIP_SIZE}" && -n "${ZIP_GEN}" ]]; then
  curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/persistZipVerificationV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"${ORG_ID}\",
      \"incidentId\":\"${INCIDENT_ID}\",
      \"zipMeta\": {
        \"zipSha256\":\"${ZIP_SHA}\",
        \"zipSize\": ${ZIP_SIZE},
        \"zipGeneratedAt\":\"${ZIP_GEN}\",
        \"verifiedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"verifiedBy\":\"repair\"
      }
    }" | python3 -m json.tool | head -n 60 || true
else
  echo "⚠️ could not read zip headers (sha/size/generatedAt) — skipping persist"
fi

echo
echo "==> Finalize incident (idempotent)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/finalizeIncidentV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&by=repair" | python3 -m json.tool | head -n 80 || true

echo
echo "==> Read truth endpoints"
echo "-- lock:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 60 || true
echo "-- zip:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true

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
