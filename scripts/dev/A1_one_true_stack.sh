#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

LOG_EMU="$ROOT/.logs/emulators.log"
LOG_NEXT="$ROOT/.logs/next.log"

echo "==> A1 One True Stack"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> HARD KILL drift (ports + firebase + next)"
PORTS=(3000 5001 8080 4000 4400 4500 9150 8670 8740 8924)
for p in "${PORTS[@]}"; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "next dev --port" 2>/dev/null || true
pkill -f "pnpm dev --port" 2>/dev/null || true
sleep 0.5

echo "==> Start emulators (functions+firestore) SINGLE instance"
rm -f "$LOG_EMU"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOG_EMU" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001 LISTEN"
for i in $(seq 1 200); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> Wait for Functions to be LOADED (not just listening)"
for i in $(seq 1 200); do
  grep -q "Loaded functions definitions from source" "$LOG_EMU" && break
  sleep 0.25
done
grep -n "Loaded functions definitions from source" "$LOG_EMU" | tail -n 1 || true
echo

echo "==> Prove hello (direct emulator)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 160; echo
echo

echo "==> Seed incident doc (Firestore emulator) baseline fields"
# NOTE: must quote URL because Firestore REST uses parentheses
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"2026-01-01T00:00:00.000Z\"}
    }
  }" | head -c 280; echo
echo

echo "==> Write next-app/.env.local emulator vars"
ENV_FILE="$ROOT/next-app/.env.local"
touch "$ENV_FILE"

upsert() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    # macOS sed needs -i ''
    sed -i '' "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
  else
    printf "%s=%s\n" "$k" "$v" >> "$ENV_FILE"
  fi
}

upsert "NEXT_PUBLIC_ENV" "local"
upsert "FIRESTORE_EMULATOR_HOST" "127.0.0.1:8080"
upsert "FIREBASE_FUNCTIONS_EMULATOR_HOST" "127.0.0.1:5001"
upsert "GCLOUD_PROJECT" "$PROJECT_ID"
upsert "FIREBASE_PROJECT_ID" "$PROJECT_ID"
echo "✅ wrote $ENV_FILE"
tail -n 10 "$ENV_FILE" || true
echo

echo "==> Start Next (clean cache)"
rm -rf "$ROOT/next-app/.next" 2>/dev/null || true
rm -f "$LOG_NEXT"
( cd next-app && pnpm dev --port "$NEXT_PORT" > "$LOG_NEXT" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next /"
for i in $(seq 1 200); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true
echo

echo "==> Generate timeline + filings (via Next proxy)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 240; echo
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=A1" | head -c 240; echo
echo

echo "==> Export packet (force=1) via Next proxy"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=A1" | head -c 300; echo
echo

echo "==> HEAD packet ZIP (extract sha/size/generatedAt)"
HDRS="$(curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | tr -d '\r')"
echo "$HDRS" | awk '
BEGIN{IGNORECASE=1}
$0 ~ /^x-peakops-zip-sha256:/ {print "zipSha256=" $2}
$0 ~ /^x-peakops-zip-size:/ {print "zipSize=" $2}
$0 ~ /^x-peakops-generatedat:/ {print "zipGeneratedAt=" $2}
'
ZIP_SHA="$(echo "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-zip-sha256:/ {print $2}' | tr -d '\n')"
ZIP_SIZE="$(echo "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-zip-size:/ {print $2}' | tr -d '\n')"
ZIP_GEN="$(echo "$HDRS" | awk 'BEGIN{IGNORECASE=1} /^x-peakops-generatedat:/ {print $2}' | tr -d '\n')"

if [[ -z "$ZIP_SHA" || -z "$ZIP_SIZE" || -z "$ZIP_GEN" ]]; then
  echo "❌ missing zip headers. Check downloadIncidentPacketZip route."
else
  echo
  echo "==> Persist zip verification"
  curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/persistZipVerificationV1" \
    -H "content-type: application/json" \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"zipSha256\":\"${ZIP_SHA}\",\"zipSize\":${ZIP_SIZE},\"zipGeneratedAt\":\"${ZIP_GEN}\",\"verifiedBy\":\"A1\"}" \
    | head -c 260; echo
fi
echo

echo "==> Finalize incident (immutable)"
curl -sS -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/finalizeIncidentV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"immutableBy\":\"A1\",\"immutableReason\":\"repair_after_seed\"}" \
  | head -c 260; echo
echo

echo "==> PROVE: lock + zip + packetMeta"
echo "-- lock:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo "-- zip:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true
echo "-- packetMeta:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true
echo

echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 $LOG_EMU"
echo "  tail -n 120 $LOG_NEXT"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
