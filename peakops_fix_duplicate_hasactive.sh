#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo "== backup =="
cp "$FILE" "$FILE.bak.$(date +%Y%m%d-%H%M%S)"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text()

pattern = re.compile(
    r'^\s*const hasActiveFieldJobs = .*?;\s*$',
    re.M
)

matches = list(pattern.finditer(s))
print(f"found hasActiveFieldJobs declarations: {len(matches)}")

if len(matches) <= 1:
    print("No duplicate declaration found. Nothing to do.")
    sys.exit(0)

# Keep the first, remove all later duplicates
parts = []
last = 0
for i, m in enumerate(matches):
    if i == 0:
        continue
    parts.append(s[last:m.start()])
    last = m.end()
parts.append(s[last:])
new_s = ''.join(parts)

p.write_text(new_s)
print("Removed duplicate hasActiveFieldJobs declaration(s), kept the first one.")
PY

echo "== verify =="
rg -n "const hasActiveFieldJobs =" "$FILE" || true

echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${PIDS:-}" ]]; then
  kill -9 $PIDS || true
fi

echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "Done. Now run:"
echo "cd ~/peakops/my-app && pnpm dev"
