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
m = re.search(r'(<Panel\s+title="Packet State[^"]*"\s*>)([\s\S]*?)(</Panel>)', s)
if not m:
    raise SystemExit("❌ Could not find Packet State panel. Search for: Panel title=\"Packet State\"")

head, body, tail = m.group(1), m.group(2), m.group(3)
body2 = body.replace("incident?.", "wf?.incident?.")
body2 = body2.replace("{{JSON.stringify", "{JSON.stringify").replace("}}", "}")

s2 = s[:m.start()] + head + body2 + tail + s[m.end():]

if s2 == s:
    print("⚠️ No changes made (already fixed?)")
else:
    p.write_text(s2)
    print("✅ Patched Packet State stub to reference wf?.incident")

PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}
