#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${PIDS:-}" ]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_isclosed_$TS"

echo
echo "== patch IncidentClient.tsx =="
python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# If already defined, do nothing.
if re.search(r'\bconst\s+isClosed\s*=\s*String\(incidentStatus\s*\|\|\s*""\)\.toLowerCase\(\)\s*===\s*"closed"', s):
    print("ℹ️ isClosed already exists")
    sys.exit(0)

# Insert right after incident status / updatedAt state usage area if possible.
anchor_patterns = [
    r'(\n\s*const\s+isDemoMode\s*=\s*isDemoIncident\(incidentId\);\s*)',
    r'(\n\s*const\s+actorUid\s*=\s*\(\)\s*=>\s*getActorUid\(\);\s*)',
    r'(\n\s*const\s+functionsBaseIsLocal\s*=\s*useMemo\(\s*\(\)\s*=>\s*\{\s*)',
]

insert_block = '\n  const isClosed = String(incidentStatus || "").toLowerCase() === "closed";\n'

done = False
for pat in anchor_patterns:
    m = re.search(pat, s)
    if m:
        idx = m.start(1)
        s = s[:idx] + insert_block + s[idx:]
        done = True
        break

# Fallback: insert before first "return (" in component body.
if not done:
    m = re.search(r'\n\s*return\s*\(\n', s)
    if not m:
        print("❌ Could not find safe insertion point for isClosed")
        sys.exit(2)
    s = s[:m.start()] + insert_block + s[m.start():]
    done = True

if s == orig:
    print("ℹ️ no changes made")
    sys.exit(0)

p.write_text(s, encoding="utf-8")
print("✅ inserted isClosed back into component scope")
PY

echo
echo "== verify =="
rg -n 'const isClosed = String\(incidentStatus \|\| ""\)\.toLowerCase\(\) === "closed"' "$FILE" || true
rg -n 'status: \{incidentStatus \|\| "open"\}' "$FILE" || true

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
