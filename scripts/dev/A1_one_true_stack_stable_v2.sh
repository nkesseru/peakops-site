#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"
REGION="us-central1"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> A1 stable stack v2"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> HARD KILL ghost ports + firebase + next"
for p in 3000 5001 8080 4000 4400 4500 9150 8670 8740 8924 8937 8990 8405; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "pnpm dev --port $NEXT_PORT" 2>/dev/null || true
pkill -f "next dev --port $NEXT_PORT" 2>/dev/null || true
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
grep -n "Loaded functions definitions from source" "$LOGDIR/emulators.log" | tail -n 1 || true
echo

echo "==> Prove hello (direct emulator)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/hello" | head -c 200; echo || true
echo

echo "==> Seed incident doc (Firestore emulator REST)"
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"2026-01-01T00:00:00.000Z\"}
    }
  }" | head -c 350; echo || true

echo "==> Confirm incident exists (GET)"
curl -sS \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  | head -c 250; echo || true
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
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true
echo

echo "==> Generate timeline + filings (via Next proxy)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 220; echo || true
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 220; echo || true
echo

echo "==> Export packet (force=1) via Next proxy"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=A1" | head -c 260; echo || true
echo

echo "==> packetMeta (should NOT be null)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 80 || true
echo

echo "==> HEAD packet ZIP (extract sha/size/generatedAt)"
HDRS="$(curl -sS -I "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}")"
zipSha256="$(printf "%s\n" "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-zip-sha256:/{gsub("\r",""); print $2}')"
zipSize="$(printf "%s\n" "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-zip-size:/{gsub("\r",""); print $2}')"
zipGeneratedAt="$(printf "%s\n" "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-generatedat:/{gsub("\r",""); print $2}')"
echo "zipSha256=${zipSha256}"
echo "zipSize=${zipSize}"
echo "zipGeneratedAt=${zipGeneratedAt}"
echo

if [[ -z "${zipSha256:-}" ]]; then
  echo "❌ could not read x-peakops-zip-sha256 header. Dumping headers:"
  printf "%s\n" "$HDRS" | sed -n '1,80p'
  echo
  echo "LOGS:"
  tail -n 120 "$LOGDIR/next.log" || true
  tail -n 120 "$LOGDIR/emulators.log" || true
  echo
  echo "STOP:"
  echo "  kill $EMU_PID $NEXT_PID"
  exit 1
fi

echo "==> Persist zip verification (POST JSON body)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/persistZipVerificationV1" \
  -H "Content-Type: application/json" \
  -d "{
    \"orgId\": \"${ORG_ID}\",
    \"incidentId\": \"${INCIDENT_ID}\",
    \"zipSha256\": \"${zipSha256}\",
    \"zipSize\": ${zipSize:-0},
    \"zipGeneratedAt\": \"${zipGeneratedAt}\",
    \"verifiedBy\": \"A1\"
  }" | python3 -m json.tool | head -n 80 || true
echo

echo "==> Finalize incident (POST JSON body)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/finalizeIncidentV1" \
  -H "Content-Type: application/json" \
  -d "{
    \"orgId\": \"${ORG_ID}\",
    \"incidentId\": \"${INCIDENT_ID}\",
    \"reason\": \"a1_one_true_stack\",
    \"by\": \"A1\"
  }" | python3 -m json.tool | head -n 80 || true
echo

echo "==> PROVE: lock + zip + packet meta"
echo "-- lock:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 80 || true
echo "-- zip:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 120 || true
echo "-- packetMeta:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 120 || true

echo
echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 ${LOGDIR}/emulators.log"
echo "  tail -n 120 ${LOGDIR}/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
