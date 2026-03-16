#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ IncidentClient.tsx not found"; exit 1; }

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${PIDS}" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== backup =="
cp "$FILE" "$FILE.bak.$(date +%Y%m%d_%H%M%S)"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# 1) Bottom Evidence button should not be blocked by field-job status.
s = s.replace(
    'disabled={isClosed || !hasActiveFieldJobs}',
    'disabled={isClosed}'
)

# 2) Clean title text so it matches the new behavior.
s = s.replace(
    ': (!hasActiveFieldJobs ? "No active field jobs (open/in_progress)" : (_hasEvidence ? "Evidence captured (done)" : "Go to Evidence"))',
    ': (_hasEvidence ? "Evidence captured (done)" : "Go to Evidence")'
)

# 3) Optional cleanup: if a duplicate hasActiveFieldJobs line was injected in the wrong place, remove it.
# Only removes the exact standalone line.
s = re.sub(
    r'^\s*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\s*\n',
    '',
    s,
    flags=re.M
)

if s == orig:
    print("ℹ️ no changes made")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ Patched IncidentClient.tsx")
PY

echo
echo "== verify =="
rg -n 'disabled=\{isClosed\}|disabled=\{isClosed \|\| !hasActiveFieldJobs\}|No active field jobs \(open/in_progress\)|Go to Evidence|Evidence captured \(done\)' "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open inc_demo"
echo "  2) Click the BOTTOM Evidence button"
echo "  3) It should now navigate just like the top one"
