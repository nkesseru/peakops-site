#!/usr/bin/env bash
set -euo pipefail

# Avoid zsh weirdness if user pastes into zsh
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

FIRESTORE_REST="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents"
NEXT_BASE="http://127.0.0.1:${NEXT_PORT}"

echo "==> sanity: Next + Firestore emulator reachable"
curl -sS -I "${NEXT_BASE}/" | head -n 1
curl -sS -I "http://127.0.0.1:8080/" | head -n 1 || true

echo "==> seed Firestore doc: incidents/${INCIDENT_ID}"
NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")"
curl -sS -X PATCH \
  "${FIRESTORE_REST}/incidents/${INCIDENT_ID}" \
  -H "content-type: application/json" \
  -d @- >/dev/null <<JSON
{
  "fields": {
    "orgId": { "stringValue": "${ORG_ID}" },
    "title": { "stringValue": "Seed Incident ${INCIDENT_ID}" },
    "startTime": { "stringValue": "${NOW_ISO}" },
    "updatedAtIso": { "stringValue": "${NOW_ISO}" }
  }
}
JSON
echo "✅ incident doc seeded"

echo "==> generate timeline (writes subcollection)"
curl -sS -X POST "${NEXT_BASE}/api/fn/generateTimelineV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"fix_incident_not_found\"}" \
  | python3 -m json.tool >/dev/null
echo "✅ timeline generated"

echo "==> generate filings (writes subcollection)"
curl -sS -X POST "${NEXT_BASE}/api/fn/generateFilingsV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"fix_incident_not_found\"}" \
  | python3 -m json.tool >/dev/null
echo "✅ filings generated"

echo "==> export packet meta (writes incident.packetMeta + timeline event)"
curl -sS "${NEXT_BASE}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=fix_incident_not_found" \
  | python3 -m json.tool

echo
echo "==> verify getIncidentPacketMetaV1 now returns ok:true"
curl -sS "${NEXT_BASE}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | python3 -m json.tool | head -n 60

echo
echo "✅ open bundle page"
echo "  ${NEXT_BASE}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
