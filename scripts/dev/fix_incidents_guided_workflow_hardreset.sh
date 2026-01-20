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

# Find the broken Guided Workflow section start
start = s.find('<PanelCard title="Guided Workflow')
if start == -1:
  raise SystemExit("❌ Could not find the Guided Workflow PanelCard start")

# Find where the export modal begins (safe anchor after this section)
m = re.search(r'\n\s*<Modal\s+open=\{exportOpen\}', s[start:])
if not m:
  raise SystemExit("❌ Could not find export modal anchor (<Modal open={exportOpen}) after Guided Workflow")

end = start + m.start()

replacement = r'''
        <PanelCard title="Guided Workflow">
          <div style={{ marginTop: 10 }}>
            <WorkflowPanel orgId={orgId} incidentId={incidentId} />
          </div>
        </PanelCard>

'''

s2 = s[:start] + replacement + s[end:]
p.write_text(s2)
print("✅ hard-reset Guided Workflow block")
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

