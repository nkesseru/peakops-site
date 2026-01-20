#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
if [[ ! -f "$PAGE" ]]; then
  echo "❌ missing file: $PAGE"
  exit 1
fi

cp "$PAGE" "$PAGE.bak_busyfix_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_busyfix_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Match common variants of the same state line
pat = re.compile(r'^\s*const\s+\[\s*busy\s*,\s*setBusy\s*\]\s*=\s*useState(?:<[^>]+>)?\(\s*false\s*\)\s*;\s*$',
                 re.MULTILINE)

matches = list(pat.finditer(s))
if len(matches) <= 1:
    print(f"✅ no duplicate busy declarations found (count={len(matches)})")
else:
    # remove all but the first match, from bottom-up so offsets don't shift
    to_remove = matches[1:]
    for m in reversed(to_remove):
        # remove the whole line (including trailing newline if present)
        start = m.start()
        end = m.end()
        # eat following newline if it exists
        if end < len(s) and s[end:end+1] == "\n":
            end += 1
        s = s[:start] + s[end:]
    p.write_text(s)
    print(f"✅ removed duplicate busy declarations: removed {len(to_remove)}, kept 1")
PY

echo "🧹 restart Next"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incident page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5 || true

echo "✅ open"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
