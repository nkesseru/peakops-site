#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # disable zsh history expansion if user runs via zsh by accident

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> C1 FieldTech polish"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

echo "==> (0) sanity: Next reachable"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true
echo

echo "==> (1) lock read (source of truth)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo

echo "==> (2) zip verification read (source of truth)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true
echo

echo "==> (3) Smoke: mutation routes WITHOUT force (should reject if immutable=true)"
echo "-- generateTimelineV1"
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 14 || true
echo
echo "-- generateFilingsV1"
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 14 || true
echo
echo "-- exportIncidentPacketV1 (no force)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 14 || true
echo

echo "==> (4) Smoke: export WITH force=1 (admin override; should succeed)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke&force=1" | head -c 260; echo || true
echo

echo "==> OPEN:"
echo "  Incident:  http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Artifact:  http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 200 ${LOGDIR}/next.log"
