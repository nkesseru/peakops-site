#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

# Always run from repo root
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Load dev env (exports FN_BASE / ORG_ID if present)
if [ -f "$ROOT/.env.dev.local" ]; then
  set -a
  source "$ROOT/.env.dev.local"
  set +a
fi

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"

echo "==> sanity: hello"
curl -sS "$FN_BASE/hello" | python3 -m json.tool >/dev/null
echo "✅ hello ok"

echo "==> create incident (DIRS only)"
INCIDENT_ID="$(
  curl -sS -X POST "$FN_BASE/createIncident" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"title\":\"Evidence Locker Test\",\"filingTypesRequired\":[\"DIRS\"],\"createdBy\":\"admin_ui\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])'
)"
echo "✅ INCIDENT_ID=$INCIDENT_ID"

echo "==> generate filings (V2)"
curl -sS -X POST "$FN_BASE/generateFilingsV2" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  >/dev/null
echo "✅ filings generated"

echo "==> set DIRS READY"
curl -sS -X POST "$FN_BASE/setFilingStatusV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"admin_ui\"}" \
  >/dev/null
echo "✅ DIRS READY"

echo "==> enqueue submit all"
curl -sS -X POST "$FN_BASE/enqueueSubmitAll" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"admin_ui\"}" \
| python3 -m json.tool

echo "==> worker tick"
curl -sS "$FN_BASE/submitQueueTick?dryRun=false" | python3 -m json.tool

echo "==> evidence locker list"
curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=25" | python3 -m json.tool

echo ""
echo "✅ Incident UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "✅ Queue UI:    http://localhost:3000/admin/queue"
