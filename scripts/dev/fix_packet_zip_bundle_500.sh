#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
[[ -f "$FILE" ]] || { echo "❌ Missing: $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# 1) Fix wrong endpoint: getIncidentBundle -> getIncidentBundleV1
s = s.replace("/api/fn/getIncidentBundle?orgId=", "/api/fn/getIncidentBundleV1?orgId=")

# 2) Remove the injected __FILINGS_BY_TYPE_V2 block that calls fetchIncidentFilings (undefined -> 500)
# Remove marker + following lines up to the next blank line
s = re.sub(r'\n/\*__FILINGS_BY_TYPE_V2__\*/\nconst __filingsByType = await fetchIncidentFilings\(orgId, incidentId\);\n', "\n", s)

# Also remove any leftover blank lines created
s = re.sub(r'\n{4,}', "\n\n", s)

p.write_text(s)
print("✅ patched: fixed bundle endpoint + removed undefined fetchIncidentFilings() call")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke packet zip"
BASE="http://127.0.0.1:3000"
curl -fsSI "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" | head -n 20

echo "==> verify bundle fetch works (should NOT create _bundle_error.json unless incident missing)"
TMP="/tmp/pkt_fix_${TS}"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123" -o "$TMP/p.zip"

echo "-- files inside zip (filings) --"
unzip -l "$TMP/p.zip" | grep -E "filings/" | head -n 40 || true

echo
echo "✅ If HEAD returned 200, the 500 is gone."
