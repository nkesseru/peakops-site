#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
set -a; source ./.env.dev.local 2>/dev/null || true; set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> sanity: hello"
curl -sSf "$FN_BASE/hello" | python3 -m json.tool | head -n 20 >/dev/null
echo "✅ functions reachable at $FN_BASE"

echo "==> create incident"
INCIDENT_ID="$(curl -sS -X POST "$FN_BASE/createIncident" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"FULL SMOKE $(date +%F_%H%M%S)\",\"filingTypesRequired\":[\"DIRS\"]}" \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])')"
echo "✅ INCIDENT_ID=$INCIDENT_ID"

echo "==> generate filings"
curl -sS -X POST "$FN_BASE/generateFilingsV2" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"smoke\"}" \
| python3 -m json.tool | head -n 30

echo "==> set DIRS READY"
curl -sS -X POST "$FN_BASE/setFilingStatusV1" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"smoke\"}" \
| python3 -m json.tool | head -n 30

echo "==> enqueue submit all"
curl -sS -X POST "$FN_BASE/enqueueSubmitAll" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"smoke\"}" \
| python3 -m json.tool | head -n 60

echo "==> run worker"
curl -sS "$FN_BASE/submitQueueTick?dryRun=false" | python3 -m json.tool | head -n 60

echo "==> evidence list"
EJSON="$(curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=25")"
echo "$EJSON" | python3 -m json.tool | head -n 40

COUNT="$(echo "$EJSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(d.get("count",0) or 0))')"
if [[ "$COUNT" -lt 2 ]]; then
  echo "❌ evidence count too low: $COUNT (expected >=2)"
  exit 1
fi
echo "✅ evidence count OK: $COUNT"

echo "==> export evidence zip"
curl -sS "$FN_BASE/exportEvidenceLockerZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=200" \
| python3 -m json.tool | head -n 40

echo
echo "✅ FULL SMOKE PASSED"
echo "✅ Incident UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "✅ Queue UI:    http://localhost:3000/admin/queue"
