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

# 1) Fix the specific known offender(s)
s = s.replace("style={{ panel() }}", "style={panel()}")
s = s.replace("style={{panel()}}", "style={panel()}")

# 2) General fix:
#    style={{ someFn() }}          -> style={someFn()}
#    style={{ someFn(true) }}      -> style={someFn(true)}
#    style={{ someFn(arg1, arg2) }}-> style={someFn(arg1, arg2)}
#
# Only touches style={{ ... }} where the inside is a single function call.
pattern = re.compile(
    r'style=\{\{\s*([A-Za-z_]\w*)\(\s*([^\)]*?)\s*\)\s*\}\}'
)

def repl(m):
    fn = m.group(1)
    args = m.group(2).strip()
    return f"style={{{fn}({args})}}" if args else f"style={{{fn}()}}"

s = pattern.sub(repl, s)

# 3) Clean up any accidental variants we’ve seen before
s = s.replace("style={{ btn() }}", "style={btn()}")
s = s.replace("style={{btn()}}", "style={btn()}")
s = s.replace("style={{ btn(true) }}", "style={btn(true)}")
s = s.replace("style={{ btn(false) }}", "style={btn(false)}")
s = s.replace("style={{btn(true)}}", "style={btn(true)}")
s = s.replace("style={{btn(false)}}", "style={btn(false)}")

if s == orig:
    print("⚠️ no changes made — search for `style={{` in the file and look for function-call styles.")
else:
    p.write_text(s)
    print("✅ patched: normalized style={{ fn(...) }} → style={fn(...)}")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: payload editor route"
curl -fsSI "http://127.0.0.1:3000/admin/contracts/car_abc123/payloads/v1_baba?orgId=org_001&versionId=v1" | head -n 12

echo
echo "✅ If you see HTTP/1.1 200, payload editor compiles again."
