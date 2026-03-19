#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
mkdir -p .logs

NEXT_BASE="http://127.0.0.1:${NEXT_PORT}"
FIRESTORE_REST="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> kill prior dev processes"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true

echo "==> start emulators (firestore+functions)"
firebase emulators:start --project "${PROJECT_ID}" --only firestore,functions > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> wait for Firestore emulator :8080"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8080" >/dev/null 2>&1; then
    echo "✅ firestore emulator up"
    break
  fi
  sleep 0.25
done

echo "==> wait for Functions emulator :5001"
for i in $(seq 1 60); do
  if curl -fsS "${FN_BASE}/hello" >/dev/null 2>&1; then
    echo "✅ functions emulator up"
    break
  fi
  # not all projects expose /hello; just check port open
  if curl -fsS "http://127.0.0.1:5001" >/dev/null 2>&1; then
    echo "✅ functions emulator port open"
    break
  fi
  sleep 0.25
done

echo "==> start Next (with FN_BASE pointing at emulator)"
export FN_BASE="$FN_BASE"
export NEXT_PUBLIC_FN_BASE="$FN_BASE"

( cd next-app && pnpm dev --port "${NEXT_PORT}" > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> sanity: Next reachable"
curl -fsS "${NEXT_BASE}/" >/dev/null
echo "✅ next up: ${NEXT_BASE}"

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

echo "==> seed Firestore incident doc: incidents/${INCIDENT_ID}"
curl -fsS -X PATCH \
  "${FIRESTORE_REST}/incidents/${INCIDENT_ID}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime&updateMask.fieldPaths=updatedAtIso" \
  -H "content-type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW_ISO}\"},
      \"updatedAtIso\": {\"stringValue\": \"${NOW_ISO}\"}
    }
  }" >/dev/null
echo "✅ incident doc seeded"

echo "==> generate timeline + filings (writes subcollections)"
curl -fsS -X POST "${NEXT_BASE}/api/fn/generateTimelineV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"fix_incident_not_found_v2\"}" >/dev/null
curl -fsS -X POST "${NEXT_BASE}/api/fn/generateFilingsV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"fix_incident_not_found_v2\"}" >/dev/null
echo "✅ timeline + filings generated"

echo "==> export packet meta (writes incident.packetMeta)"
curl -fsS "${NEXT_BASE}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=fix_incident_not_found_v2" \
  | python3 -m json.tool

echo
echo "==> verify getIncidentPacketMetaV1 now OK"
curl -fsS "${NEXT_BASE}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 80

echo
echo "✅ open bundle page:"
echo "  ${NEXT_BASE}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
open "${NEXT_BASE}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"

echo
echo "LOGS:"
echo "  tail -n 200 ${ROOT}/.logs/emulators.log"
echo "  tail -n 200 ${ROOT}/.logs/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID}  # stops emulators"
