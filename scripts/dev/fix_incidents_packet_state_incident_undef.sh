#!/usr/bin/env bash
set +H 2>/dev/null || true
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

m = re.search(r'(<Panel\s+title="Packet State\s*\(stub\)">)([\s\S]*?)(</Panel>)', s)
if not m:
    raise SystemExit('❌ Could not find Packet State (stub) panel. Search for: <Panel title="Packet State (stub)">')

head, body, tail = m.group(1), m.group(2), m.group(3)

# Fix: incident is not defined in this page. Use wf?.incident (the page already has wf in scope).
body = body.replace("incident?.", "wf?.incident?.")
body = body.replace("incident ?", "wf?.incident ?")

# Also clean up any accidental double-brace JSON.stringify artifacts if present
body = re.sub(r'JSON\.stringify\(\s*\{\{', 'JSON.stringify({', body)
body = re.sub(r'\}\}\s*,\s*null\s*,\s*2\s*\)', '}, null, 2)', body)

s2 = s[:m.start()] + head + body + tail + s[m.end():]
p.write_text(s2)
print("✅ Patched Packet State stub: incident -> wf?.incident")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ INCIDENTS PAGE GREEN"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi
