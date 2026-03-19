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

# 1) Force incRef to be the incident document ONLY
s2 = re.sub(
    r'const\s+incRef\s*=\s*db\.collection\("incidents"\)\.doc\(incidentId\)\.collection\("timeline_events"\)\.doc\(incidentId\)\s*;',
    'const incRef = db.collection("incidents").doc(incidentId);',
    s
)

# 2) Ensure query reads from timeline_events subcollection (single level)
s2 = s2.replace('incRef.collection("timelineEvents")', 'incRef.collection("timeline_events")')
s2 = s2.replace('incRef.collection("timeline_events").doc(incidentId).collection("timeline_events")',
                'incRef.collection("timeline_events")')

# 3) If the broken nested query exists, normalize it
s2 = re.sub(
    r'incRef\.collection\("timeline_events"\)\.doc\(incidentId\)\.collection\("timeline_events"\)',
    'incRef.collection("timeline_events")',
    s2
)

if s2 == s:
  raise SystemExit("❌ No changes made — patterns not found. Open getTimelineEventsV1.js and check incRef line.")
p.write_text(s2)
print("✅ patched getTimelineEventsV1: incRef=incident doc, query=timeline_events")
PY

echo "==> restart emulators (functions+firestore)"
mkdir -p .logs
lsof -tiTCP:5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
sleep 1
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null || { echo "❌ emulator not responding"; tail -n 120 .logs/emulators.log; exit 1; }
echo "✅ emulator ready (pid=$EMU_PID)"

echo
echo "==> POST generateTimelineV1 (write 2 docs)"
curl -sS -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"fix\"}" \
| python3 -m json.tool | head -n 120

echo
echo "==> GET getTimelineEvents (should be count>0 now)"
curl -sS "$FN_BASE/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 160

echo
echo "✅ done. stop emulators:"
echo "  kill $EMU_PID"
