#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ IncidentClient.tsx not found"; exit 1; }

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
cp "$FILE" "$FILE.bak_fieldjob_fix_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")

orig = s

# 1) Remove any stray hasActiveFieldJobs declaration lines anywhere
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;[ \t]*\n?',
    '',
    s,
    flags=re.M,
)

# 2) Remove any accidental selectableFieldJobs declaration duplicates
s = re.sub(
    r'\n[ \t]*const selectableFieldJobs = useMemo\(\n'
    r'(?:.*\n){0,6?}'
    r'[ \t]*\);\n',
    '\n',
    s,
    flags=re.M,
)

# 3) Find a stable anchor near the jobs-derived memo section
anchor_patterns = [
    r'(\s*const evidenceCount = evidence\.length;\n)',
    r'(\s*const latestEvidenceSec = .*\n)',
    r'(\s*const lastActivity = useMemo\(.*\n)',
]

insert_at = None
anchor_match = None
for pat in anchor_patterns:
    m = re.search(pat, s)
    if m:
        anchor_match = m
        insert_at = m.end()
        break

if insert_at is None:
    print("❌ Could not find anchor for jobs-derived memo block")
    sys.exit(1)

block = '''
  const selectableFieldJobs = useMemo(
    () => (jobs || []).filter((j: any) => isFieldSelectableJob(j?.status)),
    [jobs]
  );
  const hasActiveFieldJobs = selectableFieldJobs.length > 0;
'''

s = s[:insert_at] + block + s[insert_at:]

# 4) Safety: make sure we did not accidentally leave a const declaration inside JSX debug panel
bad_jsx = re.search(
    r'<div>incidentId:\s*\{String\(incidentId \|\| ""\)\}</div>\s*const hasActiveFieldJobs',
    s,
)
if bad_jsx:
    print("❌ Stray const still exists inside JSX")
    sys.exit(1)

# 5) Verify symbols exist exactly once
if s.count('const selectableFieldJobs = useMemo(') != 1:
    print("❌ selectableFieldJobs declaration count is not 1")
    sys.exit(1)

if s.count('const hasActiveFieldJobs = selectableFieldJobs.length > 0;') != 1:
    print("❌ hasActiveFieldJobs declaration count is not 1")
    sys.exit(1)

p.write_text(s, encoding="utf-8")
print("✅ Patched IncidentClient.tsx cleanly")
PY

echo
echo "== verify =="
rg -n "const selectableFieldJobs = useMemo|const hasActiveFieldJobs = selectableFieldJobs.length > 0;|selectableFieldJobs.length:" "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open inc_demo"
echo "  2) Confirm page loads clean"
echo "  3) Open Timeline"
echo "  4) Click Jump"
