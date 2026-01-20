#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

WF="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$WF"   "scripts/dev/_bak/GuidedWorkflowPanel_${ts}.tsx"
cp "$PAGE" "scripts/dev/_bak/incidents_page_${ts}.tsx"
echo "✅ backups saved to scripts/dev/_bak/"

python3 - <<'PY'
from pathlib import Path
import re

wf_path = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = wf_path.read_text()

needle = "setWf(workflow);"
if needle not in s:
    raise SystemExit("❌ Could not find `setWf(workflow);` in GuidedWorkflowPanel.tsx")
s = re.sub(r"\n\s*// __AUTO_INTAKE_DONE__[\s\S]*?\n\s*\}\n", "\n", s)

if "// __AUTO_INTAKE_DONE__" not in s:
    insert = r'''
      // __AUTO_INTAKE_DONE__
      // Auto-complete Intake only when backend confirms a real incident object exists.
      // (Prevents inc_TEST preview mode from auto-marking done.)
      if (j?.incident) {
        const k = "intake";
        const existing = readLocal(storageKey);
        const cur = existing[String(k)] || localStatus[String(k)];
        if (cur !== "DONE") {
          const next = { ...existing, ...localStatus, [String(k)]: "DONE" as const };
          setLocalStatus(next);
          writeLocal(storageKey, next);
        }
      }
'''
    s = s.replace(needle, needle + insert)

wf_path.write_text(s)
print("✅ patched GuidedWorkflowPanel: 1a auto-complete Intake when j.incident exists")
PY

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
s = s.replace("/*__PHASE2_EXTRAS_START__*/", "")
s = s.replace("/*__PHASE2_EXTRAS_END__*/", "")
s = s.replace("__PHASE2_EXTRAS_START__", "")
s = s.replace("__PHASE2_EXTRAS_END__", "")
s = s.replace("/*__BACKEND_BADGE__*/", "")
s = s.replace("__BACKEND_BADGE__", "")
matches = list(re.finditer(r"<TimelinePreviewMock\s*/>", s))
for mm in reversed(matches[1:]):
    s = s[:mm.start()] + s[mm.end():]

matches = list(re.finditer(r"<FilingMetaStub\b[^>]*/>", s))
for mm in reversed(matches[1:]):
    s = s[:mm.start()] + s[mm.end():]

p.write_text(s)
print("✅ patched incidents page: deduped TimelinePreviewMock + FilingMetaStub + stripped markers")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo "✅ phase2 1a+2b+3c applied (safe v2)"
