#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Replace <TimelinePreviewMock /> with prop version
s2 = re.sub(
    r"<TimelinePreviewMock\s*/>",
    "<TimelinePreviewMock orgId={orgId} incidentId={incidentId} />",
    s,
    count=1
)

if s2 == s:
    raise SystemExit("❌ Did not find `<TimelinePreviewMock />` to replace. Search for TimelinePreviewMock in the file and adjust manually.")
p.write_text(s2)
print("✅ patched incidents page: TimelinePreviewMock now receives orgId/incidentId")
PY

pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "✅ restarted next"
