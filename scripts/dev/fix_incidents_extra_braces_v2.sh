#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE='next-app/src/app/admin/incidents/[id]/page.tsx'
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
orig = s
s = re.sub(r'style=\{([A-Za-z0-9_$.]+\([^}]*\))\}\}>', r'style={\1}>', s)
s = re.sub(r'disabled=\{([^}]+)\}\}>', r'disabled={\1}>', s)
s = re.sub(r'style=\{([A-Za-z0-9_$.]+\([^}]*\))\}\}', r'style={\1}', s)
s = re.sub(r'disabled=\{([^}]+)\}\}', r'disabled={\1}', s)

if s == orig:
  raise SystemExit("❌ No changes made. Search for '}}>' near style=/disabled= in incidents page.")
p.write_text(s)
print("✅ patched incidents page: removed extra } in style/disabled props")
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
  echo "❌ still failing — first 160 lines of next.log:"
  tail -n 160 .logs/next.log || true
  echo
  echo "Open the file at the first error line:"
  echo "  nano '$FILE'"
  exit 1
fi
