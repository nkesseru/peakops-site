#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

if "GuidedWorkflowPanel\n *\n * Canonical workflow renderer" in s:
    print("✅ contract header already present")
    raise SystemExit(0)

header = '''/**
 * GuidedWorkflowPanel
 *
 * Canonical workflow renderer (intentionally self-contained).
 * - Do NOT import external workflow state helpers (no useWorkflowState / WorkflowStepCard)
 * - Steps are driven by API response + localStorage only
 * - Keep edits small + surgical (this file is a stability anchor)
 */
'''

# Insert after "use client" line if present, otherwise at top.
m = re.search(r'^\s*"use client";\s*\n', s, flags=re.M)
if m:
    s = s[:m.end()] + "\n" + header + "\n" + s[m.end():]
else:
    s = header + "\n" + s

p.write_text(s)
print("✅ inserted contract header")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ incident page OK" || { echo "❌ incident page failing"; tail -n 120 .logs/next.log; exit 1; }

echo "✅ A DONE"
