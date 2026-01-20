#!/bin/bash
set -euo pipefail
set +H 2>/dev/null || true  # disable zsh-style history expansion if run under zsh

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> A1 One True Stack v3"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> HARD KILL: old emulators + Next + ports"
for p in 3000 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "next dev --port $NEXT_PORT" 2>/dev/null || true
pkill -f "pnpm dev --port $NEXT_PORT" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions+firestore) SINGLE instance"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for ports (5001 + 8080)"
for i in $(seq 1 200); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && lsof -tiTCP:8080 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> Wait for functions to be LOADED (not just listening)"
for i in $(seq 1 240); do
  if grep -q "Loaded functions definitions from source" "$LOGDIR/emulators.log"; then
    break
  fi
  sleep 0.25
done

echo
echo "==> Show loaded functions line"
grep -n "Loaded functions definitions from source" "$LOGDIR/emulators.log" | tail -n 1 || true

echo
echo "==> Prove hello (direct emulator)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 120; echo || true

echo
echo "==> Seed incident doc into Firestore emulator (baseline fields)"
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"2026-01-01T00:00:00.000Z\"}
    }
  }" | head -c 320; echo
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
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 180; echo
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 180; echo
echo

echo "==> Export packet (force=1) via Next proxy (should be ok:true)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=A1" | head -c 260; echo
echo

echo "==> HEAD packet ZIP (extract sha/size/generatedAt)"
HDRS="$(curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | tr -d '\r')"
ZIP_SHA="$(printf "%s\n" "$HDRS" | awk -F': ' 'tolower($1)=="x-peakops-zip-sha256"{print $2}')"
ZIP_SIZE="$(printf "%s\n" "$HDRS" | awk -F': ' 'tolower($1)=="x-peakops-zip-size"{print $2}')"
ZIP_GEN="$(printf "%s\n" "$HDRS" | awk -F': ' 'tolower($1)=="x-peakops-generatedat"{print $2}')"
echo "zipSha256=$ZIP_SHA"
echo "zipSize=$ZIP_SIZE"
echo "zipGeneratedAt=$ZIP_GEN"
echo

echo "==> Persist zip verification (so badge survives refresh)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/persistZipVerificationV1" \
  -H "Content-Type: application/json" \
  -d "{
    \"orgId\":\"${ORG_ID}\",
    \"incidentId\":\"${INCIDENT_ID}\",
    \"zipSha256\":\"${ZIP_SHA}\",
    \"zipSize\":${ZIP_SIZE:-0},
    \"zipGeneratedAt\":\"${ZIP_GEN}\",
    \"verifiedBy\":\"A1\"
  }" | head -c 260; echo
echo

echo "==> Finalize incident (immutable) (idempotent)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/finalizeIncidentV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"immutableBy\":\"A1\",\"immutableReason\":\"repair_after_seed\"}" \
  | head -c 260; echo
echo

echo "==> PROVE: lock + zip + packet meta"
echo "-- lock:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 60 || true
echo "-- zip:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo "-- packetMeta:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo

echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
open "http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}" >/dev/null 2>&1 || true
open "http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}" >/dev/null 2>&1 || true

echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
