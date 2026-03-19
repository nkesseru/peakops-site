#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
if [[ ! -f "$PAGE" ]]; then
  echo "❌ missing file: $PAGE"
  exit 1
fi

cp "$PAGE" "$PAGE.bak_busyfix2_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_busyfix2_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Catch many variants:
# const [busy, setBusy] = useState(false);
# const [busy, setBusy] = useState<boolean>(false);
# const [busy, setBusy] = React.useState(false);
# (any whitespace)
pat = re.compile(
    r'^[ \t]*const[ \t]+\[[ \t]*busy[ \t]*,[ \t]*setBusy[ \t]*\][ \t]*=[ \t]*(?:React\.)?useState(?:<[^>]*>)?\([^\)]*\)[ \t]*;[ \t]*$',
    re.MULTILINE
)

matches = list(pat.finditer(s))
print(f"found busy state declarations: {len(matches)}")

if len(matches) <= 1:
    print("✅ nothing to remove")
else:
    # Keep the first, remove the rest (bottom-up)
    for m in reversed(matches[1:]):
        start, end = m.start(), m.end()
        # remove trailing newline if present
        if end < len(s) and s[end:end+1] == "\n":
            end += 1
        s = s[:start] + s[end:]
    p.write_text(s)
    print(f"✅ removed {len(matches)-1} duplicate busy declarations")
PY

echo "🧹 restart Next"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: incident page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5 || true

echo
echo "==> if still failing, show the actual busy lines:"
python3 - <<'PY'
from pathlib import Path
s = Path("next-app/src/app/admin/incidents/[id]/page.tsx").read_text().splitlines()
for i,line in enumerate(s, start=1):
    if "setBusy" in line or "[busy" in line:
        print(f"{i:4d}: {line}")
PY

echo
echo "✅ open"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
