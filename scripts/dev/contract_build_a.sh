#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

INCIDENT_ID="${1:-}"
PURPOSE="${2:-REGULATORY}"   # REGULATORY | LEGAL | OTHER

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo

# --- helpers ---
curl_json () {
  local url="$1"
  local out="$2"
  curl -sS "$url" > "$out"
  python3 -m json.tool < "$out" >/dev/null
}

post_json () {
  local path="$1"
  local body="$2"
  curl -sS -X POST "$FN_BASE/$path" \
    -H "Content-Type: application/json" \
    -d "$body"
}

need_ok () {
  python3 - <<'PY' "$1"
import json,sys
d=json.load(open(sys.argv[1]))
if not d.get("ok"):
  raise SystemExit("ok=false: "+str(d.get("error") or d))
print("ok")
PY
}

echo "==> (0) Sanity: hello"
curl -sS "$FN_BASE/hello" | python3 -m json.tool >/dev/null
echo "✅ hello ok"
echo

if [[ -z "$INCIDENT_ID" ]]; then
  echo "==> (1) Create incident (DIRS only, for deterministic smoke)"
  INCIDENT_ID="$(
    post_json "createIncident" "{\"orgId\":\"$ORG_ID\",\"title\":\"Contract Build A Smoke\",\"filingTypesRequired\":[\"DIRS\"]}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])'
  )"
  echo "✅ INCIDENT_ID=$INCIDENT_ID"
else
  echo "==> (1) Using provided INCIDENT_ID=$INCIDENT_ID"
fi
echo

echo "==> (1b) Verify incident exists (or auto-create)"
INC_OK="$(curl -sS "$FN_BASE/getIncident?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | python3 - <<'PYC'
import sys,json
try:
  d=json.load(sys.stdin)
  print("1" if d.get("ok") else "0")
except:
  print("0")
PYC
)"
if [[ "$INC_OK" != "1" ]]; then
  echo "⚠️  Incident not found in this emulator: $INCIDENT_ID"
  echo "==> Creating a fresh incident instead..."
  INCIDENT_ID="$(
    post_json "createIncident" "{\"orgId\":\"$ORG_ID\",\"title\":\"Contract Build A Auto\",\"filingTypesRequired\":[\"DIRS\"]}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["incidentId"])'
  )"
  echo "✅ NEW INCIDENT_ID=$INCIDENT_ID"
fi
echo

echo "==> (2) Generate filings + timeline"
post_json "generateBothV2" "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 60
echo

echo "==> (3) Mark DIRS READY"
post_json "setFilingStatusV1" "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"filingType\":\"DIRS\",\"toStatus\":\"READY\",\"userId\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 60
echo

echo "==> (4) Enqueue submit jobs"
post_json "enqueueSubmitAll" "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"createdBy\":\"admin_ui\"}" \
  | python3 -m json.tool | head -n 80
echo

echo "==> (5) Run worker tick"
curl -sS "$FN_BASE/submitQueueTick?dryRun=false" | python3 -m json.tool | head -n 80
echo

echo "==> (6) Ensure evidence exists (count>0)"
curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=5" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("evidence_count:", d.get("count",0)); assert int(d.get("count",0) or 0) > 0' \
  && echo "✅ evidence ok"
echo

echo "==> (7) Export RegPacket (exportRegPacketV1)"
RESP="resp_regpacket_${INCIDENT_ID}.json"
curl_json "$FN_BASE/exportRegPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=200&purpose=$PURPOSE" "$RESP"
python3 -m json.tool < "$RESP" | head -n 80
echo

ZIP_FILE="$(python3 - <<'PY' "$RESP"
import json,sys
d=json.load(open(sys.argv[1]))
if not d.get("ok"):
  raise SystemExit("exportRegPacketV1 ok=false: "+str(d.get("error") or d))
print(d["filename"])
PY
)"

echo "==> (8) Write ZIP: $ZIP_FILE"
python3 - <<'PY' "$RESP"
import json,base64,sys
d=json.load(open(sys.argv[1]))
fn=d["filename"]
b64=d["zipBase64"]
data=base64.b64decode(b64)
open(fn,"wb").write(data)
print("✅ wrote", fn, "bytes=", len(data))
PY
echo

OUTDIR="unzipped_regpacket_${INCIDENT_ID}"
echo "==> (9) Unzip -> $OUTDIR"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null
echo "✅ extracted to $OUTDIR"
find "$OUTDIR" -maxdepth 2 -type f | sed -n '1,120p'
echo

echo "✅ Contract Build A DONE"
echo "✅ Incident UI: http://localhost:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "✅ Queue UI:    http://localhost:3000/admin/queue"
echo "ZIP:    $ZIP_FILE"
echo "Folder: $OUTDIR"
