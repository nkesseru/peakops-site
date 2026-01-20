#!/usr/bin/env bash
set -euo pipefail

# --- config (args) ---
PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

LOGDIR=".logs"
EMU_LOG="$LOGDIR/emulators.log"
NEXT_LOG="$LOGDIR/next.log"

echo "==> HARD KILL known ports (avoid ghost emulators)"
PORTS=( "$NEXT_PORT" 4000 4400 4500 5001 8080 9150 9199 9299 )
for p in "${PORTS[@]}"; do
  PIDS="$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${PIDS}" ]]; then
    echo "  killing port $p -> $PIDS"
    kill -9 $PIDS 2>/dev/null || true
  fi
done

echo "==> Ensure firebase.json pins ports (firestore=8080, functions=5001, hub=4400, ui=4000, logging=4500)"
if [[ ! -f firebase.json ]]; then
  echo '{"emulators":{}}' > firebase.json
fi

node - <<'NODE'
const fs = require("fs");
const p = "firebase.json";
const j = JSON.parse(fs.readFileSync(p,"utf8"));
j.emulators = j.emulators || {};
j.emulators.ui = j.emulators.ui || { host:"127.0.0.1", port:4000 };
j.emulators.hub = j.emulators.hub || { host:"127.0.0.1", port:4400 };
j.emulators.logging = j.emulators.logging || { host:"127.0.0.1", port:4500 };
j.emulators.firestore = j.emulators.firestore || { host:"127.0.0.1", port:8080 };
j.emulators.functions = j.emulators.functions || { host:"127.0.0.1", port:5001 };
fs.writeFileSync(p, JSON.stringify(j,null,2));
console.log("✅ firebase.json updated/pinned");
NODE

echo "==> Start emulators (firestore + functions) KEEPALIVE"
mkdir -p "$LOGDIR"
rm -f "$EMU_LOG" "$NEXT_LOG"
(firebase emulators:start --only firestore,functions --project "$PROJECT_ID" >"$EMU_LOG" 2>&1) &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for Functions emulator (:5001)"
for i in $(seq 1 200); do
  if curl -fsS "http://127.0.0.1:5001/$PROJECT_ID/us-central1/hello" >/dev/null 2>&1; then
    echo "✅ functions OK"
    break
  fi
  sleep 0.25
done

echo "==> Wait for Firestore emulator (:8080) to CONNECT"
for i in $(seq 1 200); do
  if curl -fsS "http://127.0.0.1:8080/" >/dev/null 2>&1; then
    echo "✅ firestore OK"
    break
  fi
  sleep 0.25
done

echo "==> Seed incident doc via Firestore REST (prevents 'Incident not found')"
# NOTE: must quote because of (default) in URL
DOC_URL="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents?documentId=${INCIDENT_ID}"

NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
curl -fsS -X POST "$DOC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW_ISO}\"}
    }
  }" >/dev/null
echo "✅ incident seeded: incidents/${INCIDENT_ID}"

echo "==> Start Next with emulator env"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export GCLOUD_PROJECT="$PROJECT_ID"
export FIREBASE_PROJECT_ID="$PROJECT_ID"

(pkillem () { pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true; }; pkillem) || true
(rm -rf next-app/.next 2>/dev/null || true)

(cd next-app && pnpm dev --port "$NEXT_PORT" > "../$NEXT_LOG" 2>&1) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next /"
for i in $(seq 1 200); do
  if curl -fsS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.25
done

NEXT_BASE="http://127.0.0.1:${NEXT_PORT}"

echo "==> Run generators via Next API"
curl -fsS -X POST "${NEXT_BASE}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=stack" >/dev/null || true
curl -fsS -X POST "${NEXT_BASE}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=stack" >/dev/null || true
curl -fsS "${NEXT_BASE}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=stack" >/dev/null || true

echo "==> Verify: bundle + packet meta should be OK now"
echo -n "bundle: "
curl -fsS "${NEXT_BASE}/api/fn/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 120; echo
echo -n "meta:   "
curl -fsS "${NEXT_BASE}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 120; echo

echo
echo "✅ STACK UP (DO NOT CLOSE THIS TERMINAL)"
echo "OPEN:  ${NEXT_BASE}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "BUNDLE: ${NEXT_BASE}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo "LOGS:  tail -n 200 ${EMU_LOG}"
echo "       tail -n 200 ${NEXT_LOG}"
echo "STOP:  kill ${EMU_PID} ${NEXT_PID}"
echo

wait
