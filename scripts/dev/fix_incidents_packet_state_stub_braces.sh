#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE='next-app/src/app/admin/incidents/[id]/page.tsx'
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

orig = s

# Normalize any quadruple-brace accidents (style={{{{ ... }}}} -> style={{ ... }})
s = s.replace("style={{{{", "style={{").replace("}}}}", "}}")

# Fix the specific JSON.stringify double-object-literal: {{ ... }} -> { ... }
# (Only touches JSON.stringify( {{ ... }}, null, 2 ) patterns)
s = re.sub(r'JSON\.stringify\(\s*\{\{', 'JSON.stringify({', s)
s = re.sub(r'\}\}\s*,\s*null\s*,\s*2\s*\)', '}, null, 2)', s)

# Also fix accidental {{JSON.stringify( ... )}} wrappers if present
s = re.sub(r'\{\{\s*JSON\.stringify', '{JSON.stringify', s)
s = re.sub(r'\)\s*\}\}', ')}', s)

if s == orig:
    print("⚠️ No changes detected (file may already be fixed).")
else:
    p.write_text(s)
    print("✅ Patched Packet State stub braces + normalized style braces.")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ INCIDENTS PAGE GREEN"
  echo "OPEN: $URL"
else
  echo "❌ still failing — first 120 lines of next.log:"
  tail -n 120 .logs/next.log || true
  exit 1
fi
