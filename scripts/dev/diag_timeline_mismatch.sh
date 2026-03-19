#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

ROOT="$(pwd)"
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Run from repo root (contains next-app/). Current: $ROOT"
  exit 1
fi

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> Using PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID"
echo

echo "==> Ensure emulators are running (hello)"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ hello not responding at $FN_BASE/hello"
  echo "Start emulators first, or run your stack boot script."
  exit 1
}
echo "✅ hello ok"
echo

echo "==> Step 1: POST generateTimelineV1 (write)"
curl -sS -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"diag\"}" \
| python3 -m json.tool | head -n 120
echo

echo "==> Step 2: What collection path does getTimelineEventsV1 query?"
echo "---- functions_clean/getTimelineEventsV1.js ----"
nl -ba functions_clean/getTimelineEventsV1.js | sed -n '18,60p'
echo

echo "==> Step 3: Query BOTH possible subcollections via Firestore REST emulator"
FS_BASE="http://127.0.0.1:8081/v1/projects/${PROJECT_ID}/databases/(default)/documents"
DOC_BASE="${FS_BASE}/incidents/${INCIDENT_ID}"

for SUB in "timeline_events" "timelineEvents"; do
  echo "---- LIST: incidents/${INCIDENT_ID}/${SUB} ----"
  curl -sS "${DOC_BASE}/${SUB}" | python3 -m json.tool | head -n 80 || true
  echo
done

echo "==> Step 4: Call getTimelineEvents (what UI uses)"
curl -sS "$FN_BASE/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" | python3 -m json.tool | head -n 120
echo

echo "✅ DIAG DONE"
echo "If one of the REST lists shows docs and the other doesn't, that's your mismatch."
