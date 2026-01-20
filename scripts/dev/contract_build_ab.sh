#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> Create ONE incident for AB run"
INCIDENT_ID="$(curl -sS -X POST "$FN_BASE/createIncident" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"Contract Build AB Smoke\",\"filingTypesRequired\":[\"DIRS\"]}" \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])')"
echo "✅ INCIDENT_ID=$INCIDENT_ID"
echo

echo "==> Run Contract Build A (using incident)"
bash scripts/dev/contract_build_a.sh "$INCIDENT_ID" REGULATORY
echo

echo "==> Run Contract Build B (extend same incident)"
bash scripts/dev/contract_build_b.sh "$INCIDENT_ID" REGULATORY
echo

echo "✅ DONE"
echo "UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
