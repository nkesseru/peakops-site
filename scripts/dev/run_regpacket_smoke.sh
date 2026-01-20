#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
set -a; source ./.env.dev.local 2>/dev/null || true; set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> sanity: hello"
curl -sSf "$FN_BASE/hello" >/dev/null
echo "✅ functions reachable at $FN_BASE"

echo "==> create incident (DIRS only)"
INCIDENT_ID="$(curl -sS -X POST "$FN_BASE/createIncident" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"REGPACKET SMOKE $(date +%F_%H%M%S)\",\"filingTypesRequired\":[\"DIRS\"]}" \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])')"
echo "✅ INCIDENT_ID=$INCIDENT_ID"

echo "==> generate filings + timeline"
curl -sS -X POST "$FN_BASE/generateFilingsV2" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"smoke\"}" >/dev/null

curl -sS -X POST "$FN_BASE/generateTimelineV2" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"smoke\"}" >/dev/null

echo "==> set DIRS READY + enqueue + run worker"
curl -sS -X POST "$FN_BASE/setFilingStatusV1" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"smoke\"}" >/dev/null

curl -sS -X POST "$FN_BASE/enqueueSubmitAll" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"smoke\"}" >/dev/null

curl -sS "$FN_BASE/submitQueueTick?dryRun=false" >/dev/null

echo "==> exportRegPacketV1"
curl -sS "$FN_BASE/exportRegPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&purpose=REGULATORY" \
  | tee "resp_regpacket_${INCIDENT_ID}.json" \
  | python3 -m json.tool | head -n 60

ZIP_FILE="$(python3 -c "import json; print(json.load(open('resp_regpacket_${INCIDENT_ID}.json'))['filename'])")"

echo "==> write ZIP: $ZIP_FILE"
python3 - <<PY
import json,base64
d=json.load(open("resp_regpacket_${INCIDENT_ID}.json"))
open(d["filename"],"wb").write(base64.b64decode(d["zipBase64"]))
print("✅ wrote", d["filename"], "bytes=", d["sizeBytes"])
PY

OUTDIR="unzipped_regpacket_${INCIDENT_ID}"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null

echo "✅ extracted to $OUTDIR"
find "$OUTDIR" -type f -maxdepth 3

echo
echo "✅ REGPACKET SMOKE PASSED"
echo "✅ Incident UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
