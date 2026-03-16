#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${PIDS:-}" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_fix_hasActiveFieldJobs_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# 1) Remove ALL broken inserted lines, wherever they landed
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;[ \t]*\n?',
    '',
    s,
    flags=re.M
)

# 2) Remove any already-inserted jobs-based line so we don't duplicate
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = Array\.isArray\(jobs\) && jobs\.some\(\(j: any\) => isFieldSelectableJob\(j\?\.status\)\);[ \t]*\n?',
    '',
    s,
    flags=re.M
)

# 3) Insert ONE clean definition right before isClosed
anchor = 'const isClosed = String(incidentStatus || "").toLowerCase() === "closed";'
insert = 'const hasActiveFieldJobs = Array.isArray(jobs) && jobs.some((j: any) => isFieldSelectableJob(j?.status));\n\n'

if anchor not in s:
    print("❌ Could not find isClosed anchor")
    sys.exit(1)

s = s.replace(anchor, insert + anchor, 1)

if s == orig:
    print("ℹ️ no changes made")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ Patched IncidentClient.tsx")
PY

echo
echo "== verify =="
rg -n "const hasActiveFieldJobs =|const isClosed =" "$FILE" || true

echo
echo "== spot check around declaration =="
sed -n '920,945p' "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
