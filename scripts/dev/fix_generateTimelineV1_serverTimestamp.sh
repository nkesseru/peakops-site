#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

FILE="functions_clean/generateTimelineV1.js"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/generateTimelineV1.js")
s = p.read_text()

# 1) Ensure firebase-admin/firestore import exists
if 'require("firebase-admin/firestore")' not in s:
    s = s.replace(
        'const admin = require("firebase-admin");',
        'const admin = require("firebase-admin");\nconst { getFirestore, FieldValue } = require("firebase-admin/firestore");'
    )

# 2) Replace db init to use getFirestore()
s = re.sub(r'const\s+db\s*=\s*admin\.firestore\(\)\s*;', 'const db = getFirestore();', s)

# 3) Remove any old FieldValue assignment (admin.firestore.FieldValue)
s = re.sub(r'\nconst\s+FieldValue\s*=\s*admin\.firestore\.FieldValue\s*;\s*\n', '\n', s)

# 4) Replace any usage of admin.firestore.FieldValue.serverTimestamp() with FieldValue.serverTimestamp()
s = s.replace("admin.firestore.FieldValue.serverTimestamp()", "FieldValue.serverTimestamp()")

p.write_text(s)
print("✅ patched generateTimelineV1.js (getFirestore + FieldValue.serverTimestamp)")
PY

echo "==> hard restart emulators (functions+firestore)"
lsof -tiTCP:5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulator not responding"
  tail -n 120 "$LOGDIR/emulators.log" || true
  exit 1
}
echo "✅ emulator ready (pid=$EMU_PID)"

echo "==> smoke POST generateTimelineV1 (should be ok:true)"
curl -sS -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 120

echo
echo "==> smoke GET getTimelineEvents (should be count>0)"
curl -sS "$FN_BASE/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 160

echo
echo "✅ done. stop emulators:"
echo "  kill $EMU_PID"
