#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup incidents page"
cp "$FILE" "$FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) REMOVE GuidedWorkflowPanel from Panel() helper completely
s = re.sub(
    r'function Panel\([\s\S]*?\)\s*\{[\s\S]*?\n\}',
    lambda m: re.sub(
        r'<PanelCard[\s\S]*?GuidedWorkflowPanel[\s\S]*?</PanelCard>',
        '',
        m.group(0)
    ),
    s,
    flags=re.M
)

# 2) Remove any stray GuidedWorkflowPanel blocks elsewhere
s = re.sub(
    r'<PanelCard\s+title="Guided Workflow">[\s\S]*?</PanelCard>',
    '',
    s
)

# 3) Insert GuidedWorkflowPanel ONCE inside AdminIncidentDetail return
needle = re.search(r'return\s*\(\s*<div[^>]*>', s)
if not needle:
    raise SystemExit("❌ Could not find AdminIncidentDetail return root")

insert = '''
      <PanelCard title="Guided Workflow">
        <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
      </PanelCard>
'''

pos = s.find("\n", needle.end())
s = s[:pos+1] + insert + s[pos+1:]

# 4) Ensure import exists
if "GuidedWorkflowPanel" not in s:
    s = s.replace(
        'import AdminNav',
        'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\nimport AdminNav'
    )

p.write_text(s)
print("✅ GuidedWorkflowPanel FIXED (single, legal render)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ INCIDENTS PAGE GREEN" \
  || { echo "❌ still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
