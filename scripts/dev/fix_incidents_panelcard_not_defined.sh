#!/usr/bin/env bash
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

# 1) Fix Panel() helper so it NEVER references PanelCard (which is undefined + dangerous).
# Replace the entire function Panel(...) { ... } block with a safe implementation.
# (Keeps the same signature your page already expects.)
panel_pat = re.compile(r'function\s+Panel\s*\([\s\S]*?\)\s*\{[\s\S]*?\n\}', re.M)

safe_panel = r'''
function Panel({ title, children }: { title: string; children: any }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontWeight: 950, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
'''.strip()

if panel_pat.search(s):
  s = panel_pat.sub(safe_panel, s, count=1)
else:
  # If there is no Panel(), we'll insert it after imports (rare fallback).
  m = re.search(r'(^import[\s\S]*?;\s*\n)\s*\n', s, re.M)
  if m:
    s = s[:m.end()] + "\n" + safe_panel + "\n\n" + s[m.end():]
  else:
    s = safe_panel + "\n\n" + s

# 2) Remove any accidental <PanelCard ...> blocks anywhere (they're invalid here).
s = re.sub(r'<PanelCard\b[\s\S]*?</PanelCard>\s*', '', s)

# 3) Ensure GuidedWorkflowPanel import exists (and not duplicated).
if "GuidedWorkflowPanel" not in s:
  # Put it above AdminNav import if possible
  s = s.replace(
    'import AdminNav',
    'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\nimport AdminNav'
  )

# 4) Ensure the Guided Workflow render exists ONCE in the main return.
# We insert right after the error banner block if present, otherwise after the first header row.
gw_block = r'''
      <Panel title="Guided Workflow">
        <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
      </Panel>
'''.rstrip()

# Remove any existing GuidedWorkflowPanel render to avoid duplicates
s = re.sub(r'<Panel\b[^>]*title="Guided Workflow"[\s\S]*?</Panel>\s*', '', s)
s = re.sub(r'<GuidedWorkflowPanel\b[\s\S]*?\/>\s*', '', s)

# Find an insertion point inside the main return JSX:
# Prefer after a line that contains "Guided Workflow" header area? We'll place after the main header controls row.
ret = re.search(r'return\s*\(\s*<div[^>]*>\s*', s)
if not ret:
  raise SystemExit("❌ Could not find return(<div ...>) root")

insert_pos = ret.end()

# Insert after the first top-level header/action row if present
m_hdr = re.search(r'(<div\s+style=\{\{\s*display:\s*"flex"[\s\S]*?\}\}\s*>\s*[\s\S]*?</div>\s*)', s[insert_pos:insert_pos+5000])
if m_hdr:
  ip = insert_pos + m_hdr.end()
  s = s[:ip] + "\n" + gw_block + "\n" + s[ip:]
else:
  # fallback: insert immediately after return root div opening
  s = s[:insert_pos] + "\n" + gw_block + "\n" + s[insert_pos:]

p.write_text(s)
print("✅ incidents page patched: Panel fixed + GuidedWorkflowPanel inserted safely")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ INCIDENTS PAGE GREEN: $URL"
else
  echo "❌ still failing — first 80 lines of next.log:"
  tail -n 200 .logs/next.log | head -n 80
  echo
  echo "File tail:"
  tail -n 60 "next-app/src/app/admin/incidents/[id]/page.tsx"
  exit 1
fi
