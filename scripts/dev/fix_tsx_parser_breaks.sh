#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # avoid zsh history expansion weirdness if run in zsh

cd ~/peakops/my-app

FILES=(
  "next-app/src/app/admin/contracts/[id]/page.tsx"
  "next-app/src/app/admin/incidents/[id]/page.tsx"
  "next-app/src/app/admin/contracts/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx"
)

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p .logs

echo "==> (0) Backup touched files"
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "$f.bak_${ts}"
    echo "✅ backup: $f.bak_${ts}"
  fi
done

python3 - <<'PY'
from pathlib import Path
import re

files = [
  "next-app/src/app/admin/contracts/[id]/page.tsx",
  "next-app/src/app/admin/incidents/[id]/page.tsx",
  "next-app/src/app/admin/contracts/page.tsx",
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx",
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx",
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx",
]

def patch(s: str) -> str:
  # 1) Fix the big one: style={ display: ... } => style={{ display: ... }}
  #    Only when it is NOT already style={{ ... }}
  s = re.sub(r'style=\{\s*(?!\{)([^}]+)\}', r'style={{ \1 }}', s)

  # 2) Kill accidental double-quotes after PanelCard open: <PanelCard ...>">
  s = s.replace('>">', '">').replace('>">>', '">')

  # 3) Kill accidental "{<PanelCard" wrapper that breaks parsing
  s = s.replace('{<PanelCard', '<PanelCard')
  s = s.replace('{ <PanelCard', '<PanelCard')

  # 4) Remove stray triple-quote artifacts that sometimes get injected by scripts
  s = s.replace("'''", "").replace('"""', "")

  # 5) A couple of known-bad fragments we’ve seen in your logs:
  #    (These make the parser think it’s inside a string / regexp)
  s = s.replace(") }h > 0 && (", ") }\n\n      {attentionBlocks?.length > 0 && (")
  s = s.replace("}h > 0 && (", "}\n\n      {attentionBlocks?.length > 0 && (")

  return s

for fp in files:
  p = Path(fp)
  if not p.exists():
    continue
  s = p.read_text()
  s2 = patch(s)
  if s2 != s:
    p.write_text(s2)
    print(f"✅ patched: {fp}")
  else:
    print(f"ℹ️ no change: {fp}")
PY

echo "==> (1) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (2) Smoke compile (contracts + incident + packet)"
set +e
curl -fsS "http://127.0.0.1:3000/admin/contracts?orgId=org_001" >/dev/null
A=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" >/dev/null
B=$?
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null
C=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1" >/dev/null
D=$?
set -e

if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ] && [ "$D" -eq 0 ]; then
  echo "✅ OK — pages render."
  echo "OPEN:"
  echo "  http://localhost:3000/admin/contracts?orgId=org_001"
  echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
  echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
else
  echo "❌ still failing — tailing next.log"
  tail -n 180 .logs/next.log || true
  echo
  echo "Tip: the first TSX error line above is the real culprit."
  exit 1
fi
