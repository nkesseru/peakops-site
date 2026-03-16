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
cp "$FILE" "$FILE.bak_isdemomode_$TS"

echo
echo "== patch IncidentClient.tsx =="
python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

target_line = 'const isDemoMode = isDemoIncident(incidentId);'

# If already present inside component scope, do nothing.
if target_line in s:
    print("ℹ️ isDemoMode already present")
    sys.exit(0)

insert_block = '\n  const isDemoMode = isDemoIncident(incidentId);\n'

# Best place: immediately after isClosed if it exists
m = re.search(r'(\n\s*const isClosed = String\(incidentStatus \|\| ""\)\.toLowerCase\(\) === "closed";\n)', s)
if m:
    idx = m.end()
    s = s[:idx] + insert_block + s[idx:]
else:
    # Fallback: insert before first render usage of {isDemoMode ? (
    m2 = re.search(r'\n(\s*)\{isDemoMode\s*\?\s*\(', s)
    if m2:
        indent = m2.group(1)
        s = s[:m2.start()] + f'\n{indent}const isDemoMode = isDemoIncident(incidentId);\n' + s[m2.start():]
    else:
        # Final fallback: insert before first "return (" in component scope
        m3 = re.search(r'\n\s*return\s*\(\n', s)
        if not m3:
            print("❌ Could not find safe insertion point for isDemoMode")
            sys.exit(2)
        s = s[:m3.start()] + insert_block + s[m3.start():]

if s == orig:
    print("ℹ️ no changes made")
    sys.exit(0)

p.write_text(s, encoding="utf-8")
print("✅ inserted isDemoMode back into component scope")
PY

echo
echo "== verify =="
rg -n 'const isClosed = String\(incidentStatus \|\| ""\)\.toLowerCase\(\) === "closed";' "$FILE" || true
rg -n 'const isDemoMode = isDemoIncident\(incidentId\);' "$FILE" || true
rg -n '\{isDemoMode \? \(' "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next"

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open inc_demo"
echo "  2) Open Timeline"
echo "  3) Click Jump"
echo "  4) Confirm it switches to Evidence and scrolls to the matching card"
