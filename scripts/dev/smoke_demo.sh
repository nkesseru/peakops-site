#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
NEXT_PORT="${3:-3000}"

echo "==> smoke_demo: $ORG_ID / $INCIDENT_ID @ :$NEXT_PORT"
echo

curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true
echo

echo "-- workflow:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 240; echo
echo "-- packetMeta:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 240; echo
echo "-- lock:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 240; echo
echo "-- zip:"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 240; echo
echo "-- HEAD packet zip:"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | awk 'BEGIN{IGNORECASE=1} /^HTTP\/|^x-peakops-|^content-type|^content-disposition/ {print}' | head -n 40 || true
