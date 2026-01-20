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
lines = p.read_text().splitlines(True)

# Find the last "export default" (module effectively ends there + optional semicolon)
last_export = -1
for i, ln in enumerate(lines):
    if "export default" in ln:
        last_export = i

# If we found export default, strip any trailing garbage AFTER it:
# - blank lines
# - lone braces: } or };
# - leftover template quote junk
if last_export != -1:
    tail = lines[last_export+1:]
    # remove triple quote junk in tail
    tail = [ln.replace("'''","").replace('"""',"") for ln in tail]

    # Now drop trailing lines that are just braces/semicolons/whitespace
    def is_trash(ln: str) -> bool:
        s = ln.strip()
        return s == "" or s == "}" or s == "};" or s == "});" or s == ");" or s == "};\n" or s == "}\n"

    # keep stripping from end while trash
    while tail and is_trash(tail[-1]):
        tail.pop()

    lines = lines[:last_export+1] + tail

# Also remove any remaining triple quotes anywhere
out = "".join(lines).replace("'''","").replace('"""',"")
p.write_text(out)
print("✅ trimmed trailing brace/garbage after export default (if present)")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page loads: $URL"
else
  echo "❌ still failing — tailing next.log"
  tail -n 140 .logs/next.log || true
  echo
  echo "Show file tail:"
  nl -ba 'next-app/src/app/admin/incidents/[id]/page.tsx' | tail -n 60 || true
  exit 1
fi
