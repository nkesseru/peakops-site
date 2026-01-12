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
orig = s

# Fix the undefined variable: replace incident?.X -> wf?.incident?.X
s = s.replace("incident?.filingsMeta", "wf?.incident?.filingsMeta")
s = s.replace("incident?.timelineMeta", "wf?.incident?.timelineMeta")

# If there are any other optional-chained incident references, convert them too
s = re.sub(r'\bincident\?\.', 'wf?.incident?.', s)

if s == orig:
  raise SystemExit("❌ No changes made. Search manually for `incident?.` in the file.")
p.write_text(s)
print("✅ patched incidents page: incident?.* -> wf?.incident?.*")
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
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi
