#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
test -f "$FILE"
echo "$FILE"

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
cp "$FILE" "$FILE.bak_cleanup_$TS"

python3 <<'PY'
from pathlib import Path
import re

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# 1) Remove any illegal inline JS declarations inside JSX debug blocks
s = re.sub(
    r'\n[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;[ \t]*\n',
    '\n',
    s
)

# 2) Replace any remaining selectableFieldJobs usage in button guards/titles with safer jobs-based logic
#    This avoids reliance on a possibly-missing memo.
safe_guard = '(Array.isArray(jobs) && jobs.some((j:any) => isFieldSelectableJob(j?.status)))'

s = s.replace(
    'disabled={isClosed || !hasActiveFieldJobs}',
    f'disabled={{isClosed || !{safe_guard}}}'
)

s = s.replace(
    '!hasActiveFieldJobs ? "No active field jobs (open/in_progress)"',
    f'!{safe_guard} ? "No active field jobs (open/in_progress)"'
)

# 3) Remove any top-level stray hasActiveFieldJobs declarations that reference selectableFieldJobs
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n?',
    '',
    s,
    flags=re.M
)

# 4) Remove debug-panel line that references selectableFieldJobs.length if it still exists
s = re.sub(
    r'^[ \t]*<div>selectableFieldJobs\.length: \{selectableFieldJobs\.length\}</div>\n?',
    '',
    s,
    flags=re.M
)

# 5) Safety check: selectableFieldJobs should no longer appear at all unless intentionally defined
#    If a real useMemo exists, keep it. Otherwise, wipe references.
lines = s.splitlines()
has_definition = any("const selectableFieldJobs =" in line for line in lines)
if not has_definition:
    s = s.replace("selectableFieldJobs", "jobs")

if s == orig:
    print("ℹ️ No text changes were needed")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ Cleaned IncidentClient.tsx")
PY

echo
echo "== verify remaining references =="
rg -n "selectableFieldJobs|hasActiveFieldJobs" "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) /incidents/inc_demo"
echo "  2) click bottom Evidence button"
echo "  3) click Timeline → Jump"
echo "  4) open Jobs tab/page"
echo "  5) open /incidents/inc_demo?evidenceId=<some-id>"
