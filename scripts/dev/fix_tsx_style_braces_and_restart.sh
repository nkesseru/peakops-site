#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILES=(
  "next-app/src/app/admin/contracts/[id]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx"
  "next-app/src/app/admin/incidents/[id]/page.tsx"
)

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p .logs scripts/dev/_bak

echo "==> (0) Backup files"
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "scripts/dev/_bak/$(basename "$f").${ts}.bak"
    echo "✅ backup: $f -> scripts/dev/_bak/$(basename "$f").${ts}.bak"
  else
    echo "⚠️ missing (skip): $f"
  fi
done

echo "==> (1) Patch known-bad TSX style patterns"
python3 - <<'PY'
from pathlib import Path
import re

targets = [
  Path("next-app/src/app/admin/contracts/[id]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx"),
  Path("next-app/src/app/admin/incidents/[id]/page.tsx"),
]

def patch_text(s: str) -> str:
  # Remove stray triple quotes that sometimes get injected
  s = s.replace("'''", "").replace('"""', "")

  # Fix: style={{ ghostBtn() }}  -> style={ghostBtn()}
  s = re.sub(r'style=\{\{\s*ghostBtn\(\)\s*\}\}', 'style={ghostBtn()}', s)

  # Fix: style={{ statusPillStyle(x) }} -> style={statusPillStyle(x)}
  s = re.sub(r'style=\{\{\s*statusPillStyle\(([^)]+)\)\s*\}\}', r'style={statusPillStyle(\1)}', s)

  # Fix: <span style={{ statusPillStyle(x) }}>  (no closing braces)
  s = re.sub(r'style=\{\{\s*statusPillStyle\(([^)]+)\)\s*\}\}', r'style={statusPillStyle(\1)}', s)

  # Fix: style={ display: "...", ... } -> style={{ display: "...", ... }}
  # Common bad pattern: style={ display: "grid", gap: 10 }
  s = re.sub(r'style=\{\s*(display\s*:\s*[^}]+)\}', r'style={{ \1 }}', s)

  # Fix: style={{ ghostBtn() }} variants with whitespace/newlines
  s = re.sub(r'style=\{\{\s*ghostBtn\(\)\s*\}\}', 'style={ghostBtn()}', s, flags=re.S)

  # Fix: style={{ pillStyle(...) }} => style={pillStyle(...)} (generic for *PillStyle)
  s = re.sub(r'style=\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*\}\}', r'style={\1(\2)}', s)

  # Fix specific broken snippet seen in logs:
  # <button ... style={{ ghostBtn() }}>{...}</button>
  s = s.replace('style={{ ghostBtn() }}', 'style={ghostBtn()}')

  # Hard-fix a super common malformed style object: style={{ ghostBtn() }}
  s = re.sub(r'style=\{\{\s*ghostBtn\(\)\s*\}\}', 'style={ghostBtn()}', s)

  return s

for p in targets:
  if not p.exists():
    continue
  s = p.read_text()
  s2 = patch_text(s)
  if s2 != s:
    p.write_text(s2)
    print(f"✅ patched: {p}")
  else:
    print(f"ℹ️ no change: {p}")
PY

echo "==> (2) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (3) Smoke pages"
set +e
curl -fsS "http://127.0.0.1:3000/admin/contracts?orgId=org_001" >/dev/null
A=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" >/dev/null
B=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1" >/dev/null
C=$?
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null
D=$?
set -e

if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ] && [ "$D" -eq 0 ]; then
  echo "✅ OK — UI compiles"
  echo "OPEN:"
  echo "  http://localhost:3000/admin/contracts?orgId=org_001"
  echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
  echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
  echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
else
  echo "❌ Still failing — here are the first real errors:"
  tail -n 120 .logs/next.log | sed -n '1,120p'
  echo
  echo "Tip: search for the *first* TSX parser error in next.log — everything after is cascading."
  exit 1
fi
