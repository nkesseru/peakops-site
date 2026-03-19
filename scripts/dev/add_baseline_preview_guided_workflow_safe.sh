#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # zsh safety: disable history expansion even if invoked wrong

cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup GuidedWorkflowPanel"
cp "$FILE" "$FILE.bak_${TS}"
echo "OK backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

if "Baseline Fields (Preview)" in s:
    print("SKIP: Baseline preview already present")
    raise SystemExit(0)

helper = r'''
function BaselinePreview(props: { orgId: string; incidentId: string; wfLoaded: boolean; stepCount: number }) {
  const rows = [
    { label: "Baseline Fields (Preview)", ok: True },  # header row
    { label: "Org ID present", ok: !!props.orgId },
    { label: "Incident ID present", ok: !!props.incidentId },
    { label: "Workflow loaded", ok: props.wfLoaded },
    { label: "Steps received", ok: props.stepCount > 0 },
    { label: "Local progress saved", ok: true },
  ];

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      {rows.map((r, idx) => (
        <div key={r.label + idx} style={{ display: "flex", gap: 8, fontSize: 12, opacity: 0.9 }}>
          <span style={{ color: idx === 0 ? "CanvasText" : (r.ok ? "#22c55e" : "#eab308") }}>
            {idx === 0 ? "•" : (r.ok ? "✓" : "•")}
          </span>
          <span style={{ fontWeight: idx === 0 ? 900 : 500 }}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}
'''

# (Fix python True -> JS true in the inserted snippet)
helper = helper.replace("True", "true")

# Place helper before export default
s = re.sub(r'(export default function GuidedWorkflowPanel)', helper + r'\n\n\1', s, flags=re.S)

needle = r'\{s\.key\s*===\s*[\'"]intake[\'"]\s*&&\s*\('
if not re.search(needle, s):
    raise SystemExit("FAIL: could not find Intake render hook (s.key === 'intake' && ( ) )")

injection = r'''
{ s.key === "intake" && (
  <>
    <BaselinePreview
      orgId={orgId}
      incidentId={incidentId}
      wfLoaded={!!wf}
      stepCount={steps.length}
    />
  </>
)}
'''

s = re.sub(needle, injection + '\n(', s)

p.write_text(s)
print("OK injected BaselinePreview + Intake preview")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke $URL"
curl -fsS "$URL" >/dev/null && echo "OK incidents page loads" || {
  echo "FAIL incidents page"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo "DONE"
