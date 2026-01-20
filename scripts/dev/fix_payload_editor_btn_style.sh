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

# Fix the exact bad pattern(s)
s2 = s

# 1) style={{ btn(true) }}  -> style={btn(true)}
s2 = re.sub(r'style=\{\{\s*btn\((true|false)\)\s*\}\}', r'style={btn(\1)}', s2)

# 2) also catch style={{btn(true)}} etc
s2 = re.sub(r'style=\{\{\s*btn\((true|false)\)\s*\}\}', r'style={btn(\1)}', s2)

# 3) If any weird variant slipped in like style={{ btn(true) }} with extra braces
s2 = s2.replace("style={{ btn(true) }}", "style={btn(true)}")
s2 = s2.replace("style={{ btn(false) }}", "style={btn(false)}")

if s2 == s:
  print("⚠️ no changes made (pattern not found) — open the file and search for `btn(true)`")
else:
  p.write_text(s2)
  print("✅ patched payload editor: fixed style prop for btn(true/false)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke (payload editor page should return 200 now)"
curl -fsSI "http://127.0.0.1:3000/admin/contracts/car_abc123/payloads/v1_baba?orgId=org_001&versionId=v1" | head -n 8

echo
echo "✅ If you see HTTP/1.1 200, you're back."
