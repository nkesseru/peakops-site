#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="functions_clean/getTimelineEventsV1.js"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/getTimelineEventsV1.js")
s = p.read_text()

# Replace any db.collection("timeline_events") with incidents/{incidentId}/timeline_events
s2 = re.sub(
    r'db\.collection\(\s*["\']timeline_events["\']\s*\)',
    'db.collection("incidents").doc(incidentId).collection("timeline_events")',
    s
)

if s2 == s:
    print("⚠️ no `timeline_events` collection reference found to replace — open file and confirm current read path")
else:
    print("✅ updated getTimelineEventsV1 to read incidents/{incidentId}/timeline_events")

p.write_text(s2)
PY

echo
echo "==> hard restart emulators"
lsof -tiTCP:5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS http://127.0.0.1:5001/peakops-pilot/us-central1/hello >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS http://127.0.0.1:5001/peakops-pilot/us-central1/hello >/dev/null || {
  echo "❌ emulator not responding"
  tail -n 120 .logs/emulators.log
  exit 1
}
echo "✅ emulator ready (pid=$EMU_PID)"

echo
echo "==> POST generateTimelineV1"
curl -sS -X POST http://127.0.0.1:5001/peakops-pilot/us-central1/generateTimelineV1 \
  -H "Content-Type: application/json" \
  -d '{"orgId":"org_001","incidentId":"inc_TEST","requestedBy":"admin_ui"}' \
| python3 -m json.tool | head -n 120

echo
echo "==> GET getTimelineEvents (should now be count>0)"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/getTimelineEvents?orgId=org_001&incidentId=inc_TEST&limit=50" \
| python3 -m json.tool | head -n 200

echo
echo "✅ done. stop emulators:"
echo "  kill $EMU_PID"
