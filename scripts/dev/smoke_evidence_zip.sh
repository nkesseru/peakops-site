#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app
set -a; source ./.env.dev.local 2>/dev/null || true; set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> create incident (DIRS only)"
INCIDENT_ID="$(curl -sS -X POST "$FN_BASE/createIncident" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"Evidence ZIP Smoke\",\"filingTypesRequired\":[\"DIRS\"]}" \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])')"
echo "INCIDENT_ID=$INCIDENT_ID"

echo "==> generate filings"
curl -sS -X POST "$FN_BASE/generateFilingsV2" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" >/dev/null

echo "==> mark DIRS READY"
curl -sS -X POST "$FN_BASE/setFilingStatusV1" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"admin_ui\"}" >/dev/null

echo "==> enqueue"
curl -sS -X POST "$FN_BASE/enqueueSubmitAll" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"admin_ui\"}" >/dev/null

echo "==> worker tick"
curl -sS "$FN_BASE/submitQueueTick?dryRun=false" | python3 -m json.tool | head -n 40

echo "==> list evidence (expect count >= 2)"
curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=25" | python3 -m json.tool | head -n 60

echo "==> export zip"
curl -sS "$FN_BASE/exportEvidenceLockerZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=200" \
  | tee "resp_${INCIDENT_ID}.json" \
  | python3 -m json.tool | head -n 40

echo "==> write zip to disk"
python3 - <<PY
import json, base64
d=json.load(open("resp_${INCIDENT_ID}.json"))
fn=d.get("filename", f"peakops_evidence_{INCIDENT_ID}.zip")
open(fn,"wb").write(base64.b64decode(d["zipBase64"]))
print("✅ wrote", fn)
PY

ZIP_FILE="$(python3 -c "import json; print(json.load(open('resp_${INCIDENT_ID}.json'))['filename'])")"
OUTDIR="unzipped_${INCIDENT_ID}"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null

echo "✅ extracted to $OUTDIR"
ls -la "$OUTDIR"
echo "✅ Incident UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
