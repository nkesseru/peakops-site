#!/usr/bin/env bash
set -euo pipefail

NX="${NX:-http://127.0.0.1:3001}"
ORG="${ORG:-riverbend-electric}"
INC="${INC:-inc_demo}"
ACTOR="${ACTOR:-dev-admin}"
DEMO_DIR="${DEMO_DIR:-/Users/kesserumini/Downloads/PeakOps Demo Pics-3}"
UPLOAD_SH="/tmp/peakops_upload_real_demo_pic.sh"

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ Missing: $1"; exit 1; }; }
need curl
need jq

[[ -x "$UPLOAD_SH" ]] || { echo "❌ Missing uploader: $UPLOAD_SH"; exit 1; }

FILES=()
for f in "$DEMO_DIR"/*.png "$DEMO_DIR"/*.jpg "$DEMO_DIR"/*.jpeg; do
  [[ -f "$f" ]] && FILES+=( "$f" )
done
[[ "${#FILES[@]}" -gt 0 ]] || { echo "❌ No demo images in $DEMO_DIR"; exit 1; }

echo "== Seed: upload ${#FILES[@]} demo images =="
for f in "${FILES[@]}"; do
  bash "$UPLOAD_SH" "$f" >/dev/null
done

echo "== Create job =="
JOB_JSON="$(curl -sS -X POST "$NX/api/fn/createJobV1" -H "content-type: application/json" \
  --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"title\":\"SeedDemo Job $(date +%H:%M:%S)\",\"actorUid\":\"$ACTOR\"}")"
echo "$JOB_JSON" | jq
JOB_ID="$(echo "$JOB_JSON" | jq -r '.jobId // .id // ""')"
[[ -n "$JOB_ID" ]] || { echo "❌ createJobV1 returned no jobId"; exit 1; }

echo "== Link 4 newest evidence =="
EV_JSON="$(curl -sS "$NX/api/fn/listEvidenceLocker?orgId=$ORG&incidentId=$INC&limit=25")"
echo "$EV_JSON" | jq -e '.ok==true' >/dev/null

IDS=( $(echo "$EV_JSON" | jq -r '(.docs // .items // []) | .[0:4] | .[].id') )
[[ "${#IDS[@]}" -gt 0 ]] || { echo "❌ No evidence IDs found"; exit 1; }

for eid in "${IDS[@]}"; do
  curl -sS -X POST "$NX/api/fn/assignEvidenceToJobV1" -H "content-type: application/json" \
    --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"evidenceId\":\"$eid\",\"jobId\":\"$JOB_ID\"}" | jq -e '.ok==true' >/dev/null
done

echo "== Mark job complete =="
curl -sS -X POST "$NX/api/fn/updateJobStatusV1" -H "content-type: application/json" \
  --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"jobId\":\"$JOB_ID\",\"status\":\"complete\"}" | jq

echo
echo "✅ Seed complete."
echo "Open:"
echo "  $NX/incidents/$INC"
echo "  $NX/incidents/$INC/review"
