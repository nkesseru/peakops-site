#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app
mkdir -p .logs

FILE="next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

if [ ! -f "$FILE" ]; then
  echo "❌ Missing file: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx")
s = p.read_text()
orig = s

def fix_style_fn(m):
    fn = m.group(1)
    args = (m.group(2) or "").strip()
    return f"style={{{fn}({args})}}" if args else f"style={{{fn}()}}"

# Normalize style={{ panel(...) }} -> style={panel(...)} for common helpers
s = re.sub(r'style=\{\{\s*(panel|btn|pill|ghostBtn)\s*\(\s*([^\)]*)\s*\)\s*\}\}', fix_style_fn, s)

# Catch *any* style={{ someFn(...) }} wrapper (generic)
def fix_any(m):
    fn = m.group(1)
    args = (m.group(2) or "").strip()
    return f"style={{{fn}({args})}}" if args else f"style={{{fn}()}}"

s = re.sub(r'style=\{\{\s*([A-Za-z_]\w*)\s*\(\s*([^\)]*)\s*\)\s*\}\}', fix_any, s)

p.write_text(s)
print("✅ patched payload editor styles" if s != orig else "⚠️ no changes detected (already clean?)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke payload editor (HEAD)"
URL="http://127.0.0.1:3000/admin/contracts/car_abc123/payloads/v1_baba?orgId=org_001&versionId=v1"
if curl -fsSI "$URL" >/dev/null ; then
  echo "✅ PAYLOAD EDITOR GREEN"
  echo "OPEN:"
  echo "  $URL"
else
  echo "❌ still failing — first errors:"
  tail -n 120 .logs/next.log
  exit 1
fi
