#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

C_FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
I_FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p .logs scripts/dev/_bak

echo "==> (0) Backups"
[ -f "$C_FILE" ] && cp "$C_FILE" "scripts/dev/_bak/contracts_id_page.${ts}.bak" && echo "✅ backup: $C_FILE"
[ -f "$I_FILE" ] && cp "$I_FILE" "scripts/dev/_bak/incidents_id_page.${ts}.bak" && echo "✅ backup: $I_FILE"

echo "==> (1) Patch contracts/[id]/page.tsx (fix style={ display: ... } -> style={{ display: ... }})"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
if not p.exists():
    raise SystemExit("missing contracts page")

s = p.read_text()

# remove stray triple quotes if any
s = s.replace("'''", "").replace('"""', "")

# Fix the exact broken pattern from your logs:
# style={ display: "grid", gap: 10 }  -> style={{ display: "grid", gap: 10 }}
s = re.sub(r'style=\{\s*(display\s*:\s*[^}]+)\}', r'style={{ \1 }}', s)

# Fix other common broken inline style objects produced by scripts:
s = re.sub(r'style=\{\s*(opacity\s*:\s*[^}]+)\}', r'style={{ \1 }}', s)
s = re.sub(r'style=\{\s*(fontWeight\s*:\s*[^}]+)\}', r'style={{ \1 }}', s)
s = re.sub(r'style=\{\s*(marginTop\s*:\s*[^}]+)\}', r'style={{ \1 }}', s)

# Final cleanup for prompt garbage
s = s.replace("%", "")

p.write_text(s)
print("✅ contracts page patched")
PY

echo "==> (2) Patch incidents/[id]/page.tsx (remove broken StepCards block + fix style={{ fn(x) }} )"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
if not p.exists():
    raise SystemExit("missing incidents page")

s = p.read_text()

s = s.replace("'''", "").replace('"""', "").replace("%", "")

# Fix: style={{ statusPillStyle(x) }} -> style={statusPillStyle(x)}
s = re.sub(r'style=\{\{\s*statusPillStyle\(([^)]+)\)\s*\}\}', r'style={statusPillStyle(\1)}', s)

# Fix: any style={{ someFn(...) }} -> style={someFn(...)}  (generic)
s = re.sub(r'style=\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*\}\}', r'style={\1(\2)}', s)

# Remove any stray Step cards block (Phase 2) if present
# Anything starting at the marker comment up to the next </PanelCard> or next <Modal is a safe wipe.
s = re.sub(
    r"\{\s*/\*\s*Step\s+cards\s*\(Phase\s*2\)\s*\*/\s*\}[\s\S]*?(?=(<Modal\s+open=|</PanelCard>|<PanelCard\s+title=))",
    "",
    s,
    flags=re.M
)

# Also remove any WorkflowStepCard references line-by-line (keeps compile stable)
s = re.sub(r"^.*WorkflowStepCard.*$\n?", "", s, flags=re.M)

# Ensure we have ONE clean Guided Workflow panel (WorkflowPanel only)
# Remove any existing Guided Workflow PanelCard blocks first
s = re.sub(r'\s*<PanelCard\s+title="Guided Workflow"[\s\S]*?</PanelCard>\s*', "\n", s, flags=re.M)

# Ensure import for WorkflowPanel exists
if re.search(r'^\s*import\s+WorkflowPanel\s+from\s+', s, flags=re.M) is None:
    # Put it after the last import line
    imports = list(re.finditer(r'^\s*import .*?;\s*$', s, flags=re.M))
    if imports:
        ins = imports[-1].end()
        s = s[:ins] + '\nimport WorkflowPanel from "../../_components/WorkflowPanel";\n' + s[ins:]
    else:
        s = 'import WorkflowPanel from "../../_components/WorkflowPanel";\n' + s

# Insert the clean panel right after "Incident Summary" PanelCard block (best stable anchor)
anchor = re.search(r'<PanelCard title="Incident Summary">[\s\S]*?</PanelCard>\s*', s)
panel = '\n        <PanelCard title="Guided Workflow">\n          <div style={{ marginTop: 10 }}>\n            <WorkflowPanel orgId={orgId} incidentId={incidentId} />\n          </div>\n        </PanelCard>\n'
if anchor and panel.strip() not in s:
    pos = anchor.end()
    s = s[:pos] + panel + s[pos:]

p.write_text(s)
print("✅ incidents page patched (workflow panel restored, stepcards removed)")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) Smoke key pages"
set +e
curl -fsS "http://127.0.0.1:3000/admin/contracts?orgId=org_001" >/dev/null; A=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" >/dev/null; B=$?
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null; C=$?
set -e

if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ]; then
  echo "✅ COMPILE OK"
  echo "OPEN:"
  echo "  http://localhost:3000/admin/contracts?orgId=org_001"
  echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
  echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
else
  echo "❌ still failing — FIRST error in next.log:"
  # show first parser error block only
  awk 'BEGIN{p=0} /Parsing ecmascript source code failed/{p=1} p{print} NR>1 && p && /^$/{exit}' .logs/next.log | head -n 80
  echo
  echo "Tail next.log:"
  tail -n 120 .logs/next.log
  exit 1
fi
