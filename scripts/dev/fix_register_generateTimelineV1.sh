#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

if [[ ! -d "next-app" ]]; then
  echo "❌ Run from repo root (contains next-app/). Current: $(pwd)"
  exit 1
fi

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

FN_DIR="functions_clean"
INDEX_JS="$FN_DIR/index.js"
FN_FILE="$FN_DIR/generateTimelineV1.js"

echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID"
[[ -f "$FN_FILE" ]] || { echo "❌ missing: $FN_FILE"; exit 1; }
[[ -f "$INDEX_JS" ]] || { echo "❌ missing: $INDEX_JS"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs
cp "$INDEX_JS" "scripts/dev/_bak/index_js_${TS}.bak"
echo "✅ backup: scripts/dev/_bak/index_js_${TS}.bak"

python3 - <<'PY'
from pathlib import Path
import re

idx = Path("functions_clean/index.js")
s = idx.read_text()

# Add require if missing
if 'generateTimelineV1' not in s or 'require("./generateTimelineV1")' not in s:
    req_line = 'const { generateTimelineV1 } = require("./generateTimelineV1");\n'
    # Insert after last require(...) line
    requires = list(re.finditer(r'^\s*(const|let|var)\s+.*=\s*require\(.+\);\s*$', s, re.M))
    if requires:
        at = requires[-1].end()
        s = s[:at] + "\n" + req_line + s[at:]
    else:
        s = req_line + "\n" + s

# Export it (prefer module.exports object)
if re.search(r'generateTimelineV1\s*[:,]', s) is None and re.search(r'exports\.generateTimelineV1\s*=', s) is None:
    m = re.search(r'module\.exports\s*=\s*\{', s)
    if m:
        at = m.end()
        s = s[:at] + "\n  generateTimelineV1,\n" + s[at:]
    else:
        s += "\nexports.generateTimelineV1 = generateTimelineV1;\n"

idx.write_text(s)
print("✅ Patched functions_clean/index.js to include generateTimelineV1")
PY

echo "==> Ensure firebase.json uses functions_clean"
python3 - <<'PY'
from pathlib import Path
import json
p = Path("firebase.json")
data = json.loads(p.read_text())
data.setdefault("functions", {})
if data["functions"].get("source") != "functions_clean":
    data["functions"]["source"] = "functions_clean"
    p.write_text(json.dumps(data, indent=2) + "\n")
    print("✅ Set firebase.json functions.source = functions_clean")
else:
    print("✅ firebase.json already uses functions_clean")
PY

echo "==> Hard restart stack (kill ports + restart emulators + next)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "   emu pid: $EMU_PID"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> Wait for hello (max ~30s)"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator not responding"; tail -n 120 .logs/emulators.log; exit 1; }
echo "✅ emulator ready"

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> Confirm generateTimelineV1 registered (emulator log grep)"
rg -n "generateTimelineV1|http function initialized" .logs/emulators.log || true
echo

echo "==> Direct POST to emulator generateTimelineV1 (should NOT be HTML 404)"
curl -sS -i -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"diag\"}" \
  | head -n 30
echo

echo "==> Next proxy POST generateTimelineV1"
curl -sS -i -X POST "$BASE/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  | head -n 30
echo

echo "==> Timeline after"
curl -sS "$BASE/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" | head -c 260; echo
echo

echo "✅ STACK UP"
echo "OPEN:"
echo "  $BASE/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
