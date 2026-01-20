#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/incidents_id_page.${TS}.bak"
echo "✅ backup -> scripts/dev/_bak/incidents_id_page.${TS}.bak"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 0) Strip accidental triple quotes from previous patches
s = s.replace("'''", "").replace('"""', "")

# 1) Ensure GuidedWorkflowPanel import exists (safe add near other imports)
if "GuidedWorkflowPanel" not in s:
    # insert after the last import line
    m = list(re.finditer(r"^\s*import .*?;\s*$", s, flags=re.M))
    if m:
        ins = m[-1].end()
        s = s[:ins] + "\nimport GuidedWorkflowPanel from \"../_components/GuidedWorkflowPanel\";\n" + s[ins:]
    else:
        s = "import GuidedWorkflowPanel from \"../_components/GuidedWorkflowPanel\";\n" + s

# 2) Find the FIRST return( ... ) - we only want JSX inside it
m_ret = re.search(r"\breturn\s*\(", s)
if not m_ret:
    raise SystemExit("❌ Could not find `return (` in incidents page. Open the file and confirm it is a normal React component.")

ret_idx = m_ret.start()

head = s[:ret_idx]
tail = s[ret_idx:]

# 3) Remove any stray Guided Workflow PanelCard blocks BEFORE return( ... )
# (This is the specific bug you’re seeing: JSX at statement-level.)
panel_pat = re.compile(
    r"""^\s*<PanelCard\s+title=["']Guided Workflow["'][\s\S]*?^\s*</PanelCard>\s*""",
    re.M
)
head2, n = panel_pat.subn("", head)

# Also remove malformed variants like: <PanelCard title="Guided Workflow">">
head2 = head2.replace('<PanelCard title="Guided Workflow">">', "")
head2 = head2.replace('<PanelCard title="Guided Workflow">"', '<PanelCard title="Guided Workflow">')

# 4) Build the canonical in-return block
block = """
        <PanelCard title="Guided Workflow">
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        </PanelCard>
"""

# 5) Inject block INSIDE the return tree near the end (before the final wrapper closes)
# We try to insert before the last occurrence of "\n    </div>\n  );"
m_end = list(re.finditer(r"\n\s*</div>\s*\n\s*\);\s*$", tail, flags=re.M))
if not m_end:
    # fallback: insert just before the final "\n  );"
    pos = tail.rfind("\n  );")
    if pos == -1:
        raise SystemExit("❌ Could not find a safe insertion point near the end of the return. File likely malformed.")
    tail = tail[:pos] + "\n" + block + "\n" + tail[pos:]
else:
    pos = m_end[-1].start()
    tail = tail[:pos] + "\n" + block + "\n" + tail[pos:]

# 6) Write back
s2 = head2 + tail
p.write_text(s2)

print(f"✅ removed stray pre-return PanelCard blocks: {n}")
print("✅ inserted Guided Workflow PanelCard inside return")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ incidents page compiles + loads"
else
  echo "❌ still failing; tail next.log:"
  tail -n 120 .logs/next.log || true
  echo
  echo "---- show lines around first parser error ----"
  # use python to find and print nearby line numbers if possible
  python3 - <<'PY'
from pathlib import Path
s = Path(".logs/next.log").read_text()
import re
m = re.search(r"page\.tsx:(\d+):(\d+)", s)
if not m:
    print("no page.tsx line found in next.log")
    raise SystemExit(0)
line = int(m.group(1))
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx").read_text().splitlines()
start = max(1, line-20)
end = min(len(p), line+20)
for i in range(start, end+1):
    print(f"{i:4d} | {p[i-1]}")
PY
  exit 1
fi

echo
echo "✅ DONE"
echo "Open:"
echo "  $URL"
