#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 0) strip common junk that has shown up in this file over time
s = s.replace("'''","").replace('"""',"")
s = re.sub(r"\}%+\s*$", "}\n", s)
s = re.sub(r"%+\s*$", "\n", s)

# 1) Remove ALL WorkflowStepCard imports (both named + default) + WorkflowPanel import.
s = re.sub(r'^\s*import\s+\{\s*WorkflowStepCard\s*\}\s+from\s+["\'][^"\']+WorkflowStepCard["\'];\s*\n', "", s, flags=re.M)
s = re.sub(r'^\s*import\s+WorkflowStepCard\s+from\s+["\'][^"\']+WorkflowStepCard["\'];\s*\n', "", s, flags=re.M)
s = re.sub(r'^\s*import\s+WorkflowPanel\s+from\s+["\'][^"\']+WorkflowPanel["\'];\s*\n', "", s, flags=re.M)

# 2) Remove the Guided Workflow panel blocks entirely (both the clean multi-line and the busted inline versions)
s = re.sub(
  r'\s*<PanelCard\s+title="Guided Workflow"[\s\S]*?</PanelCard>\s*',
  "\n",
  s,
  flags=re.M
)

# 3) Remove any leftover references (so compile can’t choke)
s = re.sub(r'^\s*.*WorkflowStepCard.*\n', "", s, flags=re.M)
s = re.sub(r'^\s*.*WorkflowPanel.*\n', "", s, flags=re.M)

# 4) Hard normalize file ending:
# Keep everything up to the LAST occurrence of "\n  );" (component return end), then close with "\n}\n"
idx = s.rfind("\n  );")
if idx != -1:
  s = s[:idx+len("\n  );")] + "\n}\n"

# final strip of trailing prompt garbage again
s = re.sub(r"\}%+\s*$", "}\n", s)
s = re.sub(r"%+\s*$", "\n", s)

p.write_text(s)
print("✅ removed workflow remnants + normalized end-of-file")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ incidents page compiles again: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 160 .logs/next.log || true
  echo
  echo "---- tail file ----"
  nl -ba "$FILE" | tail -n 80 || true
  exit 1
fi
