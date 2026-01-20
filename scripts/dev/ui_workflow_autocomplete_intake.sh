#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p=Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s=p.read_text()

# Ensure we have a local helper to mark DONE without duplicating logic
if "function markDoneOnce(" not in s:
  ins = r'''
  function markDoneOnce(stepKey: string) {
    try {
      const k = String(stepKey);
      const current = localStatus[k] || "TODO";
      if (current === "DONE") return;
      setStatus(k, "DONE");
    } catch {}
  }
'''
  # insert after setStatus function
  s = re.sub(r'(function setStatus\([^\)]*\)\s*\{[\s\S]*?\}\n)', r'\1' + ins + '\n', s, count=1)

# Wire an effect: if wf has intake step and we can infer baseline is OK via BaselinePreview contract:
# We do it by reading a window-scoped flag set by BaselinePreview (safe + no prop threading).
# We'll add a listener that polls once shortly after load (ultra-safe).
if "WF_BASELINE_OK" not in s:
  hook = r'''
  useEffect(() => {
    // Auto-complete Intake when baseline is valid (set by BaselinePreview)
    const t = setTimeout(() => {
      try {
        const ok = (window as any)?.WF_BASELINE_OK === true;
        if (ok) markDoneOnce("intake");
      } catch {}
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf]);
'''
  # insert after the load() effect
  s = re.sub(r'(useEffect\(\(\)\s*=>\s*\{\s*void load\(\);\s*[\s\S]*?\}\s*,\s*\[orgId,\s*incidentId\]\s*\);\s*\n)',
             r'\1\n' + hook + '\n', s, count=1)

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: intake auto-DONE hook added")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ done"
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
