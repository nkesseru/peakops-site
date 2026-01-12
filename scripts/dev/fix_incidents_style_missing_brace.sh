#!/usr/bin/env bash
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

# Fix style={{ ... }>  (only ONE closing brace before >) => style={{ ... }}>
# Key: only patch when the brace before > is NOT already preceded by another brace
s = re.sub(r'style=\{\{([\s\S]*?)(?<!\})\}\s*>', r'style={{\1}}>', s)

# Also fix style={{ ... }> inside same tag when there is no whitespace before >
s = re.sub(r'style=\{\{([\s\S]*?)(?<!\})\}>', r'style={{\1}}>', s)

if s == orig:
  print("⚠️ No style-missing-brace patterns found. (Maybe already fixed or different syntax.)")
else:
  p.write_text(s)
  print("✅ Patched: missing style brace before >")

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
  tail -n 140 .logs/next.log || true
  exit 1
fi
