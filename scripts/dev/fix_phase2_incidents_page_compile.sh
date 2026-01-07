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

# 0) remove quote-junk that breaks TSX
s = s.replace("'''","").replace('"""',"")

# 1) Fix the common broken PanelCard title line (seen earlier)
#    PanelCard title="Guided Workflow   (newline)  -> make it a valid attribute
s = re.sub(r'(<PanelCard\s+title="Guided Workflow)[\s\r\n]*', r'\1">', s)

# 2) Remove stray lone "{" lines that got injected (we saw this before)
s = re.sub(r'^\s*\{\s*$', '', s, flags=re.M)

# 3) Find the Guided Workflow block marker, and ensure it sits INSIDE a PanelCard.
marker = "/* Guided Workflow (Phase 2) */"
idx = s.find(marker)
if idx == -1:
    raise SystemExit("❌ Could not find the Guided Workflow marker. Search your file for 'Guided Workflow (Phase 2)' and re-run.")

# If the marker is NOT already preceded by a PanelCard open within ~300 chars, wrap it.
pre = s[max(0, idx-300):idx]
needs_wrap = ("<PanelCard" not in pre) or ("Guided Workflow" not in pre)

if needs_wrap:
    s = s[:idx] + '<PanelCard title="Guided Workflow">\n' + s[idx:]
    # After the workflow ternary, close the PanelCard.

# 4) Ensure we close the PanelCard after the step cards ternary.
# Find the end of the ternary: the "No workflow steps" div close then ") }"
m_end = re.search(r'No workflow steps\.</div>\s*\)\s*\}', s)
if not m_end:
    # fallback: look for the specific else branch we use
    m_end = re.search(r'No workflow steps\.</div>\s*\)\s*', s)
if not m_end:
    raise SystemExit("❌ Could not find end of workflow ternary. The JSX is malformed earlier. Open the file around the workflow block and re-run.")

end_pos = m_end.end()

# If there is no </PanelCard> soon after, insert it
after = s[end_pos:end_pos+200]
if "</PanelCard>" not in after:
    s = s[:end_pos] + "\n</PanelCard>\n" + s[end_pos:]

# 5) Ensure the module ends with a clean return close.
# If file doesn't contain a final ');\n}' near the end, append a safe tail.
tail = s[-400:]
if ");" not in tail or not re.search(r'\n\}\s*$', s):
    # try to close any open root div + return + function
    s = s.rstrip() + "\n\n  </div>\n  );\n}\n"

p.write_text(s)
print("✅ incidents page repaired (wrapped workflow + ensured closing tags)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page loads: $URL"
else
  echo "❌ still failing — tailing next.log"
  tail -n 120 .logs/next.log || true
  echo
  echo "Show file tail:"
  nl -ba "next-app/src/app/admin/incidents/[id]/page.tsx" | tail -n 80 || true
  exit 1
fi
