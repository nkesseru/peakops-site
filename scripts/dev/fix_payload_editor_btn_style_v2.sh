#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx")
s = p.read_text()

orig = s

# Fix ALL variants:
# style={{ btn() }}      -> style={btn()}
# style={{btn()}}        -> style={btn()}
# style={{ btn(true) }}  -> style={btn(true)}
# style={{btn(false)}}   -> style={btn(false)}
s = re.sub(r'style=\{\{\s*btn\(\s*\)\s*\}\}', r'style={btn()}', s)
s = re.sub(r'style=\{\{\s*btn\(\s*(true|false)\s*\)\s*\}\}', r'style={btn(\1)}', s)

# Also catch weird double-wrapped like style={{ (btn(true)) }}
s = re.sub(r'style=\{\{\s*\(?\s*btn\(\s*(true|false)?\s*\)\s*\)?\s*\}\}', lambda m: f"style={{btn({m.group(1)})}}" if m.group(1) else "style={btn()}", s)

# If any "style={{ btn" still exists, hard replace minimal safe fallback:
s = s.replace("style={{ btn() }}", "style={btn()}")
s = s.replace("style={{ btn(true) }}", "style={btn(true)}")
s = s.replace("style={{ btn(false) }}", "style={btn(false)}")

if s == orig:
  print("⚠️ no changes made — search manually for `style={{ btn` in the file.")
else:
  p.write_text(s)
  print("✅ patched: normalized all style={{ btn(...) }} -> style={btn(...)}")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke (payload editor should compile)"
curl -fsSI "http://127.0.0.1:3000/admin/contracts/car_abc123/payloads/v1_baba?orgId=org_001&versionId=v1" | head -n 12 || true
echo
echo "If it's still 500, run:"
echo "  tail -n 60 .logs/next.log"
