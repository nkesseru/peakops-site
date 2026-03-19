#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
LOG=".logs/emulators.log"

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo "==> INCIDENT_ID=$INCIDENT_ID"
echo

echo "==> smoke hello"
curl -sS "$FN_BASE/hello" | head -c 200; echo
echo

echo "==> POST generateTimelineV1 (capture status + raw body)"
RESP="$(curl -sS -D - -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  -o /tmp/_gt_body.txt || true)"

STATUS="$(echo "$RESP" | head -n 1 | awk '{print $2}')"
CTYPE="$(echo "$RESP" | rg -i '^content-type:' | head -n 1 | cut -d: -f2- | xargs || true)"

echo "HTTP_STATUS=$STATUS"
echo "CONTENT_TYPE=${CTYPE:-<none>}"
echo
echo "---- body (first 600 chars) ----"
head -c 600 /tmp/_gt_body.txt; echo
echo
echo "---- try parse json ----"
python3 - <<'PY' || true
import json
p="/tmp/_gt_body.txt"
t=open(p,"r",encoding="utf-8",errors="replace").read().strip()
print("len=",len(t))
if not t:
  print("EMPTY_BODY")
  raise SystemExit(0)
try:
  j=json.loads(t)
  print("JSON_OK keys=", list(j.keys())[:25])
except Exception as e:
  print("JSON_PARSE_FAIL:", e)
PY

echo
echo "==> tail emulator log (last 120)"
if [[ -f "$LOG" ]]; then
  tail -n 120 "$LOG"
else
  echo "⚠️ no $LOG (is emulator running?)"
fi
