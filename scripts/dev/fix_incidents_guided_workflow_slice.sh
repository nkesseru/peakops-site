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

# Remove triple-quote junk everywhere
s = s.replace("'''","").replace('"""',"")

# Normalize the most common corruptions:
s = s.replace('<PanelCard title="Guided Workflow">">', '<PanelCard title="Guided Workflow">')
s = re.sub(r'\{\s*<PanelCard title="Guided Workflow">\s*', '<PanelCard title="Guided Workflow">', s)

start = s.find("/* Guided Workflow (Phase 2) */")
if start == -1:
    # fallback: find the corrupted PanelCard title
    start = s.find('PanelCard title="Guided Workflow')
    if start == -1:
        raise SystemExit("❌ Could not find Guided Workflow start anchor")

# Find end anchor = next PanelCard title after workflow section
end_candidates = [
    r'<PanelCard title="Filing Actions"',
    r'<PanelCard title="Incident Summary"',
    r'<PanelCard title="Filings"',
    r'<PanelCard title="Timeline"',
    r'<PanelCard title="Evidence Locker"',
]
end = None
for pat in end_candidates:
    m = re.search(pat, s[start:])
    if m:
        end = start + m.start()
        break

if end is None:
    # last resort: end at the component return close
    m = re.search(r'\n\s*\);\s*\n\}', s[start:])
    if not m:
        raise SystemExit("❌ Could not find a safe end anchor after Guided Workflow")
    end = start + m.start()

replacement = '''
      <PanelCard title="Guided Workflow">
        <div style={{ marginTop: 10 }}>
          <WorkflowPanel orgId={orgId} incidentId={incidentId} />
        </div>
      </PanelCard>

'''

s2 = s[:start] + replacement + s[end:]

# One more cleanup: fix an unterminated PanelCard title line if it exists
s2 = re.sub(r'<PanelCard\s+title="Guided Workflow[^\n"]*\n', '<PanelCard title="Guided Workflow">\n', s2)

p.write_text(s2)
print("✅ Guided Workflow section hard-replaced")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page compiles + loads: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 140 .logs/next.log || true
  echo
  echo "Tail file:"
  nl -ba 'next-app/src/app/admin/incidents/[id]/page.tsx' | tail -n 90 || true
  exit 1
fi
