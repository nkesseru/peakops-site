#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

if [[ ! -f "$FILE" ]]; then
  echo "❌ Missing file: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_c3A_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_c3A_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

if "workflowMissingDerived" not in s:
    raise SystemExit("❌ workflowMissingDerived not found. Run the earlier C3 v2 banner patch first (the one that adds workflowMissingDerived).")

changes = []

# 1) Make Auto-checks label conditional (MANUAL vs CRITICAL)
if 'Auto-checks: CRITICAL' in s and 'workflowMissingDerived ? "Auto-checks: MANUAL"' not in s:
    s = s.replace('Auto-checks: CRITICAL', '{workflowMissingDerived ? "Auto-checks: MANUAL" : "Auto-checks: CRITICAL"}', 1)
    changes.append("label: Auto-checks conditional")

# 2) Gate scary inline error text (if it exists as raw text)
if "Workflow API returned non-JSON" in s and "{!workflowMissingDerived &&" not in s:
    s2, n = re.subn(
        r'(Workflow API returned non-JSON[^\n<]*)',
        r'{!workflowMissingDerived && (<> \1 </>)}',
        s,
        count=1
    )
    if n:
        s = s2
        changes.append("gated scary workflow non-json text")

# 3) If there is any boolean severity flag, force it off in manual mode
for varname in ["isCritical", "critical"]:
    m = re.search(rf'(^\s*const\s+{varname}\s*=\s*)([^;]+);', s, flags=re.M)
    if m and "workflowMissingDerived" not in m.group(2):
        s = s[:m.start()] + f"{m.group(1)}(!workflowMissingDerived) && ({m.group(2).strip()});" + s[m.end():]
        changes.append(f"{varname}: disabled in manual mode")
        break

p.write_text(s)

if changes:
    print("✅ C3-A applied:")
    for c in changes:
        print("  -", c)
else:
    print("ℹ️ C3-A: nothing changed (maybe already applied).")
PY

echo "🧹 restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null 2>&1 || true

echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/next.log"
