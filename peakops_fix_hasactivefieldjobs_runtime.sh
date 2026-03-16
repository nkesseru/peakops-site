#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"

if [[ ! -f "$FILE" ]]; then
  echo "❌ IncidentClient.tsx not found"
  exit 1
fi

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_hasActiveFieldJobs_$TS"

echo
echo "== patch IncidentClient.tsx =="
python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

if re.search(r'const\s+hasActiveFieldJobs\s*=', s):
    print("ℹ️ hasActiveFieldJobs already exists")
    sys.exit(0)

m = re.search(
    r'(const\s+selectableFieldJobs\s*=\s*useMemo\([\s\S]*?\);\n)',
    s
)
if not m:
    print("❌ Could not find selectableFieldJobs block")
    sys.exit(2)

insert = m.group(1) + '  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n'
s = s[:m.start()] + insert + s[m.end():]

if s == orig:
    print("⚠️ No changes made")
    sys.exit(3)

p.write_text(s, encoding="utf-8")
print("✅ inserted hasActiveFieldJobs back into component scope")
PY

echo
echo "== verify =="
rg -n 'const selectableFieldJobs|const hasActiveFieldJobs' "$FILE" || true
rg -n 'disabled=\{isClosed \|\| !hasActiveFieldJobs\}' "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next"

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open inc_demo"
echo "  2) Confirm page loads again"
echo "  3) Open Timeline"
echo "  4) Click Jump"
echo "  5) See whether it switches to Evidence + scrolls"
