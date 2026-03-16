#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ File not found"; exit 1; }

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
cp "$FILE" "$FILE.bak_hasactive_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

bad_line = r'^\s*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\s*$'
s = re.sub(bad_line + r'\n?', '', s, flags=re.M)

good_line = '  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n'

if good_line.strip() not in s:
    anchor = '  const isClosed = String(incidentStatus || "").toLowerCase() === "closed";'
    if anchor not in s:
        print("❌ Could not find isClosed anchor")
        sys.exit(1)
    s = s.replace(anchor, good_line + "\n" + anchor, 1)

p.write_text(s, encoding="utf-8")
print("✅ Patched IncidentClient.tsx")
PY

echo
echo "== verify =="
rg -n "const hasActiveFieldJobs|selectableFieldJobs.length > 0|const isClosed =" "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
