#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="functions_clean/exportIncidentPacketV1.js"
cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_*"

python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/exportIncidentPacketV1.js")
s = p.read_text()

# Ensure we have an incidentData object and packet uses it.
# 1) If we find packet = {... incident, ...} replace with incident: incidentData
s = s.replace("packet = { orgId, incidentId, exportedAt, incident, filings, timelineEvents }",
              "packet = { orgId, incidentId, exportedAt, incident: incidentData, filings, timelineEvents }")

# 2) If packet uses `incident,` in other formatting, try a safer replacement
s = s.replace("incident, filings, timelineEvents", "incident: incidentData, filings, timelineEvents")

# 3) Ensure incidentData is defined (after incidentSnap load)
needle = "const incidentSnap = await incidentRef.get();"
if needle in s and "const incidentData" not in s:
    s = s.replace(needle, needle + "\n\n    const incidentData = incidentSnap.exists ? (incidentSnap.data() || {}) : {};\n")
else:
    # If incidentSnap variable name differs, we won't guess—leave as-is.
    pass

p.write_text(s)
print("✅ patched exportIncidentPacketV1.js (packet uses incidentData)")
PY

echo "✅ done. Restart emulators after this if they’re running."
