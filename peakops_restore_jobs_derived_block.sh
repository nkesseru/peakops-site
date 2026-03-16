#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak.$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")

# 1) Remove any stray in-JSX const line accidentally inserted into render output
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\s*$\n?',
    '',
    s,
    flags=re.M,
)

# 2) Remove previously inserted broken single-line derived vars if present
patterns = [
    r'^[ \t]*const selectableFieldJobs = Array\.isArray\(jobs\).*?\n',
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;.*?\n',
    r'^[ \t]*const showJobsDebugPanel = false;.*?\n',
    r'^[ \t]*const rawJobsDebug: any\[\] = \[\];.*?\n',
    r'^[ \t]*const normalizedJobStatuses: any\[\] = \[\];.*?\n',
]
for pat in patterns:
    s = re.sub(pat, '', s, flags=re.M)

anchor = 'const isClosed = String(incidentStatus || "").toLowerCase() === "closed";'
if anchor not in s:
    print("❌ Could not find anchor for restore block")
    sys.exit(1)

block = """const selectableFieldJobs = useMemo(
  () => (Array.isArray(jobs) ? jobs.filter((j: any) => isFieldSelectableJob(j?.status)) : []),
  [jobs]
);
const hasActiveFieldJobs = selectableFieldJobs.length > 0;
const showJobsDebugPanel = false;
const rawJobsDebug: any[] = [];
const normalizedJobStatuses: any[] = [];
"""

s = s.replace(anchor, block + "\n" + anchor, 1)

p.write_text(s, encoding="utf-8")
print("✅ Restored stable jobs-derived block")
PY

echo
echo "== verify =="
rg -n "const selectableFieldJobs|const hasActiveFieldJobs|const showJobsDebugPanel|const rawJobsDebug|const normalizedJobStatuses|const isClosed =" "$FILE" || true

echo
echo "== kill 3001 if occupied =="
PID="$(lsof -tiTCP:3001 -sTCP:LISTEN || true)"
if [[ -n "${PID:-}" ]]; then
  kill -9 $PID || true
fi

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
echo "  2) Jobs tab"
echo "  3) bottom Evidence button"
echo "  4) Timeline -> Jump"
