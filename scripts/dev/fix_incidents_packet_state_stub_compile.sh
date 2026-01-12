#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
s = re.sub(r"\{\s*/\*\s*PACKET_STATE_STUB\s*\*/\s*\}[\s\S]*?(?=\n\s*\{/\*|\n\s*<Panel|\n\s*</div>|\n\s*\);\s*\n|\Z)", "", s, count=1)
s = re.sub(r"<Panel\s+title=\{?\"Packet State.*?\"?\}?>[\s\S]*?</Panel>\s*", "", s, count=1)
s = re.sub(r"<Panel\s+title=\{?\"Packet State\s*\(stub\)\"?\}?>[\s\S]*?</Panel>\s*", "", s, count=1)

m = re.search(r'<Panel\s+title=\{?"Guided Workflow"\}?>[\s\S]*?</Panel>', s)
if not m:
  raise SystemExit("❌ Could not find the Guided Workflow <Panel ...> block to anchor insertion.")

insert_pos = m.end()
s = s[:insert_pos] + "\n\n" + block + "\n\n" + s[insert_pos:]

p.write_text(s)
print("✅ patched incidents page: removed broken Packet State + reinserted clean stub")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ INCIDENTS PAGE GREEN: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi
