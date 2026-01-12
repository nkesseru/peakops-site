#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Normalize AdminNav + GuidedWorkflowPanel imports to correct relative path
s = re.sub(r'import\s+AdminNav\s+from\s+[\'"]\.\./_components/AdminNav[\'"]\s*;', 
           'import AdminNav from "../../_components/AdminNav";', s)
s = re.sub(r'import\s+AdminNav\s+from\s+[\'"]\.\./_components/AdminNav[\'"]\s*', 
           'import AdminNav from "../../_components/AdminNav"', s)

s = re.sub(r'import\s+GuidedWorkflowPanel\s+from\s+[\'"]\.\./_components/GuidedWorkflowPanel[\'"]\s*;', 
           'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";', s)
s = re.sub(r'import\s+GuidedWorkflowPanel\s+from\s+[\'"]\.\./_components/GuidedWorkflowPanel[\'"]\s*', 
           'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel"', s)

# Also fix the OTHER wrong variant your log showed: "../_components/AdminNav"
s = re.sub(r'import\s+AdminNav\s+from\s+[\'"]\.\./\.\./_components/AdminNav[\'"]\s*;', 
           'import AdminNav from "../../_components/AdminNav";', s)
s = re.sub(r'import\s+GuidedWorkflowPanel\s+from\s+[\'"]\.\./\.\./_components/GuidedWorkflowPanel[\'"]\s*;', 
           'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";', s)

p.write_text(s)
print("✅ patched import paths")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke $URL"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ INCIDENTS PAGE GREEN: $URL"
else
  echo "❌ still failing — tailing next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi
