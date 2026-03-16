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
cp "$FILE" "$FILE.bak_hasactivefieldjobs_$TS"

echo
echo "== patch IncidentClient.tsx =="
python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

target_line = "const hasActiveFieldJobs = selectableFieldJobs.length > 0;"

# 1) Remove ALL stray copies first
s = re.sub(r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n?', '', s, flags=re.M)

# 2) Reinsert exactly once right after selectableFieldJobs useMemo block
anchor_pattern = re.compile(
    r'(const selectableFieldJobs = useMemo\([\s\S]*?\n\s*\[jobs\]\s*\)\s*;)',
    re.M
)

m = anchor_pattern.search(s)
if not m:
    print("❌ selectableFieldJobs block not found")
    sys.exit(1)

insert = m.group(1) + "\n  const hasActiveFieldJobs = selectableFieldJobs.length > 0;"
s = s[:m.start()] + insert + s[m.end():]

if s == orig:
    print("ℹ️ no changes made")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ cleaned stray hasActiveFieldJobs lines and reinserted in component scope")
PY

echo
echo "== verify =="
rg -n "const selectableFieldJobs|const hasActiveFieldJobs" "$FILE" || true

echo
echo "== show nearby area =="
LINE="$(rg -n "const hasActiveFieldJobs" "$FILE" | head -n1 | cut -d: -f1 || true)"
if [[ -n "${LINE:-}" ]]; then
  START=$((LINE-8))
  END=$((LINE+8))
  [[ $START -lt 1 ]] && START=1
  sed -n "${START},${END}p" "$FILE"
fi

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
