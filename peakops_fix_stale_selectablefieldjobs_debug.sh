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
cp "$FILE" "$FILE.bak.$(date +%Y%m%d_%H%M%S)"

python3 <<'PY'
from pathlib import Path
import re
p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text()

orig = s

# Remove stale debug row that still references selectableFieldJobs directly
s = re.sub(
    r'\n([ \t]*)<div>selectableFieldJobs\.length:\s*\{selectableFieldJobs\.length\}</div>',
    '',
    s
)

# If somehow a stale inline const got injected into JSX, remove it too
s = re.sub(
    r'\n([ \t]*)const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n',
    '\n',
    s
)

# Optional: replace any remaining debug display usage with the safe guard
s = s.replace(
    '{selectableFieldJobs.length}',
    '{hasActiveFieldJobs ? "1+" : "0"}'
)

if s == orig:
    print("No changes made")
else:
    p.write_text(s)
    print("Patched IncidentClient.tsx")
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
