#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="functions_clean/getTimelineEventsV1.js"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/getTimelineEventsV1.js")
s = p.read_text()

# Replace the first occurrence of any db.collection("SOMETHING") with the correct subcollection:
# db.collection("incidents").doc(incidentId).collection("timeline_events")
s2, n = re.subn(
    r'db\.collection\(\s*["\'][^"\']+["\']\s*\)',
    'db.collection("incidents").doc(incidentId).collection("timeline_events")',
    s,
    count=1
)

if n == 0:
    raise SystemExit("❌ Could not find any db.collection(...) call to patch. Open the file and confirm it uses db.collection().")

p.write_text(s2)
print("✅ patched first db.collection(...) -> incidents/{incidentId}/timeline_events")
PY

echo "==> restart emulators"
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
| python3 -m json.tool | head -n 80

echo
echo "==> GET getTimelineEvents (should be count>0)"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/getTimelineEvents?orgId=org_001&incidentId=inc_TEST&limit=50" \
| python3 -m json.tool | head -n 120

echo
echo "✅ done. stop emulators:"
echo "  kill $EMU_PID"
