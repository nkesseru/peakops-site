#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
[ -f "$FILE" ] || { echo "❌ missing: $FILE"; exit 1; }

bak="$FILE.bak_c3_$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$bak"
echo "✅ backup: $bak"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# 1) Ensure workflowSoftDown state exists
if "workflowSoftDown" not in s:
    m = re.search(r"(useState<[^>]+>\\([^)]*\\);\\s*\\n)", s)
    if not m:
        m = re.search(r"(useState\\([^)]*\\);\\s*\\n)", s)
    if not m:
        raise SystemExit("❌ could not find a useState() line to anchor workflowSoftDown")
    ins = "  const [workflowSoftDown, setWorkflowSoftDown] = useState<boolean>(false);\\n"
    s = s[:m.end()] + ins + s[m.end():]

# 2) Ensure helper exists
if "function isWorkflowSoftDown" not in s:
    helper = """
function isWorkflowSoftDown(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  const t = (bodyText || "").toLowerCase();
  if (t.includes("does not exist") && t.includes("valid functions")) return true;
  if (t.includes("function us-central1-getworkflowv1 does not exist")) return true;
  return false;
}
"""
    mi = re.search(r"^(import[\\s\\S]+?\\n)\\n", s, re.M)
    if not mi:
        raise SystemExit("❌ could not find import block to insert helper")
    s = s[:mi.end()] + helper + "\\n" + s[mi.end():]

# 3) Convert scary errors into soft/manual mode
s = s.replace(
    "setErr(`Workflow API returned non-JSON (HTTP ${r.status}): ${pj.err}`);",
    "if (isWorkflowSoftDown(r.status, pj.text || pj.err || \"\")) {\\n"
    "  setWorkflowSoftDown(true);\\n"
    "  setErr(\"\");\\n"
    "} else {\\n"
    "  setWorkflowSoftDown(false);\\n"
    "  setErr(`Workflow API returned non-JSON (HTTP ${r.status}): ${pj.err}`);\\n"
    "}"
)

s = s.replace(
    "setErr(j.error || `Workflow API error (HTTP ${r.status})`);",
    "if (isWorkflowSoftDown(r.status, JSON.stringify(j || {}))) {\\n"
    "  setWorkflowSoftDown(true);\\n"
    "  setErr(\"\");\\n"
    "} else {\\n"
    "  setWorkflowSoftDown(false);\\n"
    "  setErr(j.error || `Workflow API error (HTTP ${r.status})`);\\n"
    "}"
)

# 4) Add a calm banner
if "Workflow engine not active yet" not in s:
    banner = """
{workflowSoftDown && (
  <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 12, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", fontSize: 12 }}>
    Workflow engine not active yet — running in manual mode. (This is OK in dev.)
  </div>
)}
"""
    m = re.search(r"(Guided Workflow[\\s\\S]{0,200}\\n)", s)
    if m:
        s = s[:m.end()] + banner + s[m.end():]
    else:
        m2 = re.search(r"(return\\s*\\(\\s*<div[^>]*>\\s*\\n)", s)
        if m2:
            s = s[:m2.end()] + banner + s[m2.end():]

p.write_text(s)
print("✅ C3 patched GuidedWorkflowPanel (workflow 404 => manual mode)")
PY

echo "🧹 restart Next"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true
echo "LOGS: tail -n 120 .logs/next.log"
