#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 0) Strip common garbage that breaks TSX parsing
s = s.replace("'''", "").replace('"""', "")

# 1) Remove any injected "Step cards (Phase 2)" / WorkflowStepCard blocks if they exist
s = re.sub(r"\{\s*/\*\s*Step\s+cards\s*\(Phase\s*2\)\s*\*/\s*\}[\s\S]*?(?:No workflow steps\.[\s\S]*?\)\s*\}|\}\s*\)\s*:\s*\([\s\S]*?\)\s*\})",
           "", s, flags=re.MULTILINE)

# 2) Hard-reset the Guided Workflow PanelCard itself (replace from start to its closing </PanelCard>)
start = s.find('<PanelCard title="Guided Workflow')
if start == -1:
    raise SystemExit("❌ Could not find Guided Workflow PanelCard start")

# find the first </PanelCard> after start (closing for that panel)
end = s.find("</PanelCard>", start)
if end == -1:
    raise SystemExit("❌ Could not find </PanelCard> after Guided Workflow start")
end = end + len("</PanelCard>")

replacement = '''
        <PanelCard title="Guided Workflow">
          <div style={{ marginTop: 10 }}>
            <WorkflowPanel orgId={orgId} incidentId={incidentId} />
          </div>
        </PanelCard>
'''

s = s[:start] + replacement + s[end:]

# 3) Fix common broken attribute: PanelCard title accidentally became an unterminated string
# If someone left: <PanelCard title="Guided Workflow  (no closing quote)
s = re.sub(r'<PanelCard\s+title="Guided Workflow[^"]*?\n', '<PanelCard title="Guided Workflow">\n', s)

# 4) Remove any stray lone "{" line that sometimes gets injected
s = re.sub(r"^\s*\{\s*$", "", s, flags=re.MULTILINE)

p.write_text(s)
print("✅ incidents page: Guided Workflow block hard-reset + Step cards removed")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke compile"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incident page loads: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 160 .logs/next.log || true
  echo
  echo "Tip: open the file around the reported line:"
  echo "  nl -ba next-app/src/app/admin/incidents/[id]/page.tsx | sed -n '1080,1135p'"
  exit 1
fi
