#!/usr/bin/env bash
set +H 2>/dev/null || true
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

# Start at the broken Guided Workflow card
start = s.find('<PanelCard title="Guided Workflow')
if start == -1:
  raise SystemExit("❌ Could not find '<PanelCard title=\"Guided Workflow'")

# End at the next Modal block (submit/cancel/export/etc)
m = re.search(r'\n\s*<Modal\s+open=\{', s[start:])
if not m:
  raise SystemExit("❌ Could not find any '<Modal open={' anchor after Guided Workflow block")

end = start + m.start()

replacement = '''
        <PanelCard title="Guided Workflow">
          <div style={{ marginTop: 10 }}>
            <WorkflowPanel orgId={orgId} incidentId={incidentId} />
          </div>
        </PanelCard>

'''

# Also nuke stray triple quotes if they exist
prefix = s[:start].replace("'''","").replace('"""',"")
suffix = s[end:]
s2 = prefix + replacement + suffix

p.write_text(s2)
print("✅ hard-reset Guided Workflow block (v2)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page compiles now" \
  || { echo "❌ still failing — tailing next.log"; tail -n 120 .logs/next.log; exit 1; }
