#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # stop zsh event expansion issues

cd ~/peakops/my-app

FILE='next-app/src/app/admin/incidents/[id]/page.tsx'
TS="$(date +%Y%m%d_%H%M%S)"

if [ ! -f "$FILE" ]; then
  echo "❌ missing file: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# --- 1) Remove the extra "Guided Workflow" PanelCard block (the compact one near the bottom) ---
# This targets exactly:
# <PanelCard title="Guided Workflow"><div style={{ marginTop: 10 }}>
#   <WorkflowPanel ... />
# </div>
# </PanelCard>
s, n = re.subn(
  r"\n\s*<PanelCard title=\"Guided Workflow\"><div style=\{\{ marginTop: 10 \}\}>\s*\n"
  r"\s*<WorkflowPanel\s+orgId=\{orgId\}\s+incidentId=\{incidentId\}\s*/>\s*\n"
  r"\s*</div>\s*\n"
  r"\s*</PanelCard>\s*\n",
  "\n",
  s,
  count=1
)

# --- 2) Clean up duplicate/incorrect imports at top ---
lines = s.splitlines()

out = []
seen = set()

def drop_line(line: str) -> bool:
  # Drop the named import variant (we will keep the default import from ../../_components)
  if re.search(r"import\s+\{\s*WorkflowStepCard\s*\}\s+from\s+['\"]/../_components/WorkflowStepCard['\"]", line):
    return True
  # Drop any duplicate default import of WorkflowStepCard if we already have one
  if re.search(r"import\s+WorkflowStepCard\s+from\s+['\"]/../_components/WorkflowStepCard['\"]", line):
    return True
  # We keep WorkflowPanel import, but we also de-dupe if it appears more than once
  return False

for line in lines:
  if drop_line(line):
    continue
  key = line.strip()
  # de-dupe exact identical import lines
  if key.startswith("import ") and key in seen:
    continue
  if key.startswith("import "):
    seen.add(key)
  out.append(line)

s2 = "\n".join(out)

# --- 3) Ensure we have the correct WorkflowStepCard import path (your project uses ../../_components) ---
if "import WorkflowStepCard from \"../../_components/WorkflowStepCard\";" not in s2 and \
   "import WorkflowStepCard from '../../_components/WorkflowStepCard';" not in s2:
  # Insert it after react imports if present, else after "use client";
  m = re.search(r"^import\s+\{[^}]*\}\s+from\s+['\"]react['\"];?\s*$", s2, flags=re.M)
  if m:
    insert_at = m.end()
    s2 = s2[:insert_at] + "\nimport WorkflowStepCard from \"../../_components/WorkflowStepCard\";" + s2[insert_at:]
  else:
    m2 = re.search(r"^\"use client\";?\s*$", s2, flags=re.M)
    if m2:
      insert_at = m2.end()
      s2 = s2[:insert_at] + "\n\nimport WorkflowStepCard from \"../../_components/WorkflowStepCard\";" + s2[insert_at:]
    else:
      s2 = "import WorkflowStepCard from \"../../_components/WorkflowStepCard\";\n" + s2

p.write_text(s2)

print(f"✅ removed duplicate Guided Workflow panel: {n} occurrence(s)")
print("✅ imports deduped + WorkflowStepCard import normalized")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ OK: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 160 .logs/next.log || true
  echo
  echo "---- show duplicate guided workflow remnants ----"
  grep -n "Guided Workflow" -n 'next-app/src/app/admin/incidents/[id]/page.tsx' || true
  exit 1
fi
