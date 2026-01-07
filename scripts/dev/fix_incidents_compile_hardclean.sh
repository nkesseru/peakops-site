#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # avoid zsh history expansion

cd ~/peakops/my-app
FILE='next-app/src/app/admin/incidents/[id]/page.tsx'

if [ ! -f "$FILE" ]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 0) Remove any accidental terminal junk that may have been written (common culprits)
#    - trailing % from prompts
#    - stray triple quotes
s = s.replace("'''", "").replace('"""', "")
s = re.sub(r"\}\s*%+\s*$", "}\n", s)         # }%  -> }
s = re.sub(r"%+\s*$", "\n", s)              # trailing %... -> newline

# 1) Dedupe WorkflowStepCard imports:
#    - remove named import { WorkflowStepCard } ...
#    - keep default import WorkflowStepCard from "../../_components/WorkflowStepCard"
lines = s.splitlines(True)
out = []
seen_import = set()

for ln in lines:
    if re.search(r"import\s+\{\s*WorkflowStepCard\s*\}\s+from\s+['\"]/../_components/WorkflowStepCard['\"]", ln):
        continue
    if re.search(r"import\s+WorkflowStepCard\s+from\s+['\"]/../_components/WorkflowStepCard['\"]", ln):
        continue

    key = ln.strip()
    if key.startswith("import "):
        if key in seen_import:
            continue
        seen_import.add(key)
    out.append(ln)

s = "".join(out)

# Ensure correct default import exists
if "import WorkflowStepCard from \"../../_components/WorkflowStepCard\";" not in s and \
   "import WorkflowStepCard from '../../_components/WorkflowStepCard';" not in s:
    # insert after react import if possible, else after "use client"
    m = re.search(r"^import\s+\{[^}]*\}\s+from\s+['\"]react['\"];?\s*$", s, flags=re.M)
    ins = "\nimport WorkflowStepCard from \"../../_components/WorkflowStepCard\";\n"
    if m:
        s = s[:m.end()] + ins + s[m.end():]
    else:
        m2 = re.search(r"^\"use client\";?\s*$", s, flags=re.M)
        if m2:
            s = s[:m2.end()] + "\n" + ins + s[m2.end():]
        else:
            s = ins + s

# 2) If there are TWO Guided Workflow PanelCards, remove the one that is "inline" (same line as <div...)
#    Keep the clean multi-line one.
s, _ = re.subn(
    r"\n\s*<PanelCard title=\"Guided Workflow\"><div style=\{\{ marginTop: 10 \}\}>\s*\n"
    r"\s*<WorkflowPanel\s+orgId=\{orgId\}\s+incidentId=\{incidentId\}\s*/>\s*\n"
    r"\s*</div>\s*\n"
    r"\s*</PanelCard>\s*\n",
    "\n",
    s,
    count=1
)

# 3) HARD ENFORCE: file must end exactly with:
#    </div>\n  );\n}\n
#    This fixes the common "parser dies at final }" situation caused by trailing junk / missing closures.
s = s.rstrip() + "\n"

# Find the LAST occurrence of "  );" and cut everything after the matching closing brace.
# If missing, do nothing (we'll just normalize tail if we can).
idx = s.rfind("\n  );")
if idx != -1:
    # keep through "  );"
    head = s[:idx+len("\n  );")]
    # now find a closing brace after that, if any
    tail = s[idx+len("\n  );"):]
    # remove everything and replace with "\n}\n"
    s = head + "\n}\n"

# Final strip of trailing junk again
s = re.sub(r"\}\s*%+\s*$", "}\n", s)
s = re.sub(r"%+\s*$", "\n", s)

p.write_text(s)
print("✅ hardclean applied (imports + duplicate panel + tail normalized)")
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
  echo "---- file tail ----"
  nl -ba "$FILE" | tail -n 80 || true
  exit 1
fi
