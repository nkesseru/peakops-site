#!/usr/bin/env bash
set +H 2>/dev/null || true
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

# 0) Strip accidental triple quotes if any
s = s.replace("'''", "").replace('"""', "")

# 1) Remove ALL existing Guided Workflow PanelCard blocks (we'll insert one clean copy)
block_pat = re.compile(
    r'<PanelCard\s+title="Guided Workflow">\s*[\s\S]*?</PanelCard>\s*',
    re.M
)
s, n = block_pat.subn("", s)
print(f"✅ removed existing Guided Workflow PanelCard blocks: {n}")

# 2) Ensure GuidedWorkflowPanel import exists
if "GuidedWorkflowPanel" in s and "from" in s:
    if re.search(r'import\s+GuidedWorkflowPanel\s+from', s) is None:
        # Insert after the last import line
        lines = s.splitlines(True)
        last_import = 0
        for i, line in enumerate(lines):
            if line.strip().startswith("import "):
                last_import = i
        ins = 'import GuidedWorkflowPanel from "../_components/GuidedWorkflowPanel";\n'
        lines.insert(last_import + 1, ins)
        s = "".join(lines)
        print("✅ inserted GuidedWorkflowPanel import")
else:
    # still try: add it after last import
    lines = s.splitlines(True)
    last_import = 0
    for i, line in enumerate(lines):
        if line.strip().startswith("import "):
            last_import = i
    ins = 'import GuidedWorkflowPanel from "../_components/GuidedWorkflowPanel";\n'
    lines.insert(last_import + 1, ins)
    s = "".join(lines)
    print("✅ inserted GuidedWorkflowPanel import (fallback)")

# 3) Insert ONE clean PanelCard inside the main return
# We inject right before the last occurrence of "\n    </div>\n  );"
anchor = re.search(r'\n\s*</div>\s*\n\s*\);\s*\n\s*\}\s*$', s)
if not anchor:
    # fallback: before the last "\n  );"
    idx = s.rfind("\n  );")
    if idx == -1:
        raise SystemExit("❌ Could not find return closing ');' to insert Guided Workflow block.")
    insert_at = idx
else:
    insert_at = anchor.start()

panel = """
        <PanelCard title="Guided Workflow">
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        </PanelCard>
"""

s = s[:insert_at] + panel + s[insert_at:]
print("✅ inserted Guided Workflow PanelCard inside return")

p.write_text(s)
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ incidents page loads: $URL"
else
  echo "❌ still failing — first parser error:"
  awk '/Parsing ecmascript source code failed/{p=1} p{print} /Unexpected token/{exit}' .logs/next.log | head -n 60
  echo
  echo "Tail of file:"
  noglob nl -ba next-app/src/app/admin/incidents/[id]/page.tsx | tail -n 60
  exit 1
fi
