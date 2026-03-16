#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_hasactivefieldjobs_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

bad_line = 'const hasActiveFieldJobs = selectableFieldJobs.length > 0;'

# 1) remove any rogue copies anywhere in the file
s = s.replace("  " + bad_line + "\n", "")
s = s.replace(bad_line + "\n", "")

# 2) if already defined in component scope, stop here
if re.search(r'\bconst hasActiveFieldJobs\s*=\s*selectableFieldJobs\.length\s*>\s*0;', s):
    p.write_text(s, encoding="utf-8")
    print("already had a scoped hasActiveFieldJobs; rogue JSX copy removed")
    sys.exit(0)

# 3) insert right after selectableFieldJobs useMemo block
anchor = re.search(
    r'(const selectableFieldJobs = useMemo\([\s\S]*?\);\n)',
    s
)
if not anchor:
    print("FAILED: could not find selectableFieldJobs useMemo block")
    sys.exit(1)

insert = anchor.group(1) + '  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n'
s = s[:anchor.start()] + insert + s[anchor.end():]

p.write_text(s, encoding="utf-8")
print("inserted hasActiveFieldJobs in component scope and removed rogue JSX copy")
PY

echo
echo "== verify =="
rg -n "const hasActiveFieldJobs|selectableFieldJobs.length > 0" "$FILE" || true

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
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
