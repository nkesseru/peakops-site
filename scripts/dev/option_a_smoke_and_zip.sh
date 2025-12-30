#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> ROOT=$ROOT"
echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"

echo "==> (0) Stop dev stack (best-effort)"
bash scripts/dev/dev-down.sh 2>/dev/null || true

echo "==> (1) Start dev stack"
# This script starts emulators + next; keep it in foreground so it stays alive
# If your dev-up starts emulators in background, that's fine—we hard-wait below.
bash scripts/dev/dev-up.sh >/dev/null 2>&1 || true

echo "==> (2) Hard-wait for Functions /hello to respond"
ok=0
for i in $(seq 1 160); do
  if curl -sSf "$FN_BASE/hello" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.25
done

if [[ "$ok" != "1" ]]; then
  echo "❌ Functions emulator never became ready (hello still failing)."
  echo "==> Tail emulators log:"
  tail -n 120 .logs/emulators.log 2>/dev/null || true
  echo "==> Check if port 5001 is listening:"
  lsof -n -iTCP:5001 -sTCP:LISTEN || true
  exit 1
fi

echo "✅ functions hello OK"

echo "==> smoke: listIncidents"
curl -sSf "$FN_BASE/listIncidents?orgId=$ORG_ID" | python3 -m json.tool | head -n 30

echo "==> (3) Create incident (DIRS only)"
INCIDENT_ID="$(curl -sS -X POST "$FN_BASE/createIncident" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"EvidenceLocker FULL Smoke\",\"filingTypesRequired\":[\"DIRS\"]}" \
| python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])')"
echo "✅ INCIDENT_ID=$INCIDENT_ID"

echo "==> (4) Generate filings"
curl -sS -X POST "$FN_BASE/generateFilingsV2" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 40

echo "==> (5) Mark DIRS READY"
curl -sS -X POST "$FN_BASE/setFilingStatusV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 40

echo "==> (6) Enqueue submit all"
curl -sS -X POST "$FN_BASE/enqueueSubmitAll" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 60

echo "==> (7) Run worker"
curl -sS "$FN_BASE/submitQueueTick?dryRun=false" | python3 -m json.tool | head -n 80

echo "==> (8) Evidence locker list"
curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=25" | python3 -m json.tool | head -n 80

echo "==> (9) Export evidence zip -> write file -> unzip"
curl -sS "$FN_BASE/exportEvidenceLockerZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=200" \
  | tee "resp_${INCIDENT_ID}.json" \
  | python3 -m json.tool | head -n 40

python3 - <<PY
import json, base64
d=json.load(open("resp_${INCIDENT_ID}.json"))
fn=d.get("filename") or f"peakops_evidence_{d.get('incidentId','unknown')}.zip"
b=d.get("zipBase64","")
open(fn,"wb").write(base64.b64decode(b))
print("✅ wrote", fn)
PY

ZIP_FILE="$(python3 -c "import json; print(json.load(open('resp_${INCIDENT_ID}.json'))['filename'])")"
OUTDIR="unzipped_${INCIDENT_ID}"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null
echo "✅ extracted to $OUTDIR"
ls -la "$OUTDIR" | head -n 50

echo "✅ Incident UI: http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "✅ Queue UI:    http://localhost:3000/admin/queue"
