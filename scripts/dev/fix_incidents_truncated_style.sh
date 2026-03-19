#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup"
cp "$FILE" "$FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

orig = s

# Fix the truncated alignItems line (the real culprit)
s = re.sub(
    r'display:\s*"flex",\s*justifyContent:\s*"space-between",\s*gap:\s*10,\s*alignItems:\s*\$',
    'display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center"',
    s
)

if s == orig:
    raise SystemExit("❌ Did not find truncated alignItems line — aborting to avoid damage")

p.write_text(s)
print("✅ fixed truncated style line")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
