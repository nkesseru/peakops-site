#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

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
cp "$FILE" "$FILE.bak_cleanup_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# 1) Remove any stray inline const accidentally inserted inside JSX/debug render
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n',
    '',
    s,
    flags=re.M
)

# 2) Replace the old dev debug block with a safe version that only uses live vars
safe_debug = '''{process.env.NODE_ENV !== "production" ? (
                  <div className="rounded-lg border border-cyan-300/25 bg-cyan-500/10 p-2 text-[11px] text-cyan-100">
                    <div><span className="peakops-debug-only">jobs.length:</span> {jobs.length}</div>
                    <div>currentJobId: {String(currentJobId || "(empty)")}</div>
                    <div>incidentId: {String(incidentId || "")}</div>
                    <div>hasActiveFieldJobs: {String(hasActiveFieldJobs)}</div>
                  </div>
                ) : null}'''

s = re.sub(
    r'\{process\.env\.NODE_ENV !== "production" \? \([\s\S]*?\) : null\}',
    safe_debug,
    s,
    count=1
)

# 3) Remove any remaining orphaned references to deleted vars in this file
s = re.sub(r'^[^\n]*selectableFieldJobs[^\n]*\n', '', s, flags=re.M)
s = re.sub(r'^[^\n]*normalizedJobStatuses[^\n]*\n', '', s, flags=re.M)

# 4) Make sure the only guard we use is the safe jobs-based one
if 'const hasActiveFieldJobs = Array.isArray(jobs) && jobs.some((j: any) => isFieldSelectableJob(j?.status));' not in s:
    anchor = 'const isClosed = String(incidentStatus || "").toLowerCase() === "closed";'
    if anchor not in s:
        print("❌ Could not find isClosed anchor")
        sys.exit(1)
    s = s.replace(
        anchor,
        'const hasActiveFieldJobs = Array.isArray(jobs) && jobs.some((j: any) => isFieldSelectableJob(j?.status));\n\n  ' + anchor,
        1
    )

p.write_text(s, encoding="utf-8")
print("✅ Cleaned IncidentClient.tsx")
PY

echo
echo "== verify remaining risky refs =="
rg -n "selectableFieldJobs|normalizedJobStatuses|hasActiveFieldJobs" "$FILE" || true

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
echo "  2) bottom Evidence button"
echo "  3) Timeline → Jump"
echo "  4) /incidents/inc_demo?evidenceId=<some-id>"
echo "  5) Jobs tab"
