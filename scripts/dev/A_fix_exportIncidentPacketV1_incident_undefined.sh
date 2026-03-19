#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PROJECT_ID="peakops-pilot"
ORG_ID="org_001"
INCIDENT_ID="inc_TEST"
NEXT_PORT="3000"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

FILE="functions_clean/exportIncidentPacketV1.js"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_fix_incident_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $FILE.bak_fix_incident_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/exportIncidentPacketV1.js")
s = p.read_text()

# Ensure we define incidentData after incidentSnap is loaded
m = re.search(r"(const\\s+incidentSnap\\s*=\\s*await\\s+incidentRef\\.get\\(\\)\\;\\s*\\n)", s)
if not m:
    raise SystemExit("❌ could not find: const incidentSnap = await incidentRef.get();")

if "const incidentData =" not in s:
    ins = "    const incidentData = incidentSnap.exists ? (incidentSnap.data() || {}) : {};\n"
    s = s[:m.end()] + ins + s[m.end():]

# Replace any reference to `incident` payload with incidentData
# Most important: packet construction
s = re.sub(r"\\bincident\\b(?=\\s*,\\s*filings\\b)", "incidentData", s)
s = re.sub(r"(const\\s+packet\\s*=\\s*\\{[^\\}]*?)\\bincident\\b", r"\\1incidentData", s)

# Replace property access incident.xxx -> incidentData.xxx
s = s.replace("incident.", "incidentData.")

p.write_text(s)
print("✅ patched exportIncidentPacketV1.js: no undefined incident; uses incidentData")
PY

echo
echo "==> HARD KILL ghost emulators/ports"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore)"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001"
for i in $(seq 1 160); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo
echo "==> hello (proves functions loaded)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 120; echo || true

echo
echo "==> Export packet DIRECT emulator (expect ok:true)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 260; echo || true

echo
echo "==> Export packet via Next proxy (expect ok:true)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 260; echo || true

echo
echo "==> Confirm packetMeta non-null"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true

echo
echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Bundle:   http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo
echo "STOP:"
echo "  kill $EMU_PID"
