#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ IncidentClient.tsx not found"; exit 1; }

echo
echo "== kill port 3001 if occupied =="
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
cp "$FILE" "$FILE.bak_hasactivefieldjobs_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

# 1) Remove every stray hasActiveFieldJobs declaration anywhere in file
s = re.sub(
    r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n?',
    '',
    s,
    flags=re.M
)

# 2) Find the selectableFieldJobs useMemo block
anchor = re.search(
    r'^[ \t]*const selectableFieldJobs = useMemo\([\s\S]*?\n[ \t]*\);\n',
    s,
    flags=re.M
)

if not anchor:
    print("❌ Could not find selectableFieldJobs useMemo block")
    sys.exit(1)

insert_at = anchor.end()
insert_text = '  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n'

# 3) Insert directly after selectableFieldJobs block
s = s[:insert_at] + insert_text + s[insert_at:]

if s == orig:
    print("ℹ️ no changes made")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ Patched IncidentClient.tsx")
PY

echo
echo "== verify =="
rg -n "const selectableFieldJobs = useMemo|const hasActiveFieldJobs = selectableFieldJobs.length > 0;|const isClosed =" "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
