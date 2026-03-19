#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # avoid zsh history/event expansion issues

cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

if [ ! -f "$FILE" ]; then
  echo "❌ missing file: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Remove any stray triple quotes that sometimes get injected by scripts
s = s.replace("'''", "").replace('"""', "")

# 2) Fix the exact issue shown: duplicate PanelCard lines back-to-back
#    <PanelCard title="Guided Workflow">\n<PanelCard title="Guided Workflow">
s2, n = re.subn(
  r'(<PanelCard\s+title="Guided Workflow"\s*>\s*)\n\s*(<PanelCard\s+title="Guided Workflow"\s*>\s*)',
  r'\1',
  s,
  count=1
)

# 3) Also fix a common related corruption: "{<PanelCard ...>" (PanelCard accidentally placed inside braces)
#    This turns "{<PanelCard title="Guided Workflow">" -> "<PanelCard title="Guided Workflow">"
s3, n2 = re.subn(
  r'\{\s*(<PanelCard\s+title="Guided Workflow"\s*>)',
  r'\1',
  s2
)

# 4) If we removed an opening tag accidentally earlier (rare), ensure the Guided Workflow PanelCard closes.
#    If there is a WorkflowPanel inside a Guided Workflow PanelCard, but no close soon after, add it.
#    (We keep this conservative.)
if 'title="Guided Workflow"' in s3:
  # Find the first Guided Workflow block
  i = s3.find('title="Guided Workflow"')
  chunk = s3[i:i+800]
  if "WorkflowPanel" in chunk and "</PanelCard>" not in chunk:
    # Insert a close right after the WorkflowPanel wrapper div closes
    s3 = re.sub(
      r'(<WorkflowPanel[^>]*?/>\s*</div>\s*)',
      r'\1</PanelCard>\n',
      s3,
      count=1
    )

p.write_text(s3)
print(f"✅ patched incidents page (removed dup PanelCard: {n}, fixed brace-wrapped PanelCard: {n2})")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ OK: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 140 .logs/next.log || true
  echo
  echo "---- show Guided Workflow area ----"
  python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text().splitlines()
for idx, line in enumerate(s, start=1):
  if 'Guided Workflow' in line or 'WorkflowPanel' in line or 'WorkflowStepCard' in line:
    start = max(1, idx-8)
    end = min(len(s), idx+18)
    print(f"\n--- context around line {idx} ---")
    for j in range(start, end+1):
      print(f"{j:5d} {s[j-1]}")
PY
  exit 1
fi

echo
echo "OPEN:"
echo "  $URL"
