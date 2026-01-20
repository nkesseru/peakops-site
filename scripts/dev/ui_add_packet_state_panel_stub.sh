#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p=Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s=p.read_text()

# Only inject once
if "PACKET_STATE_STUB" not in s:
  panel = r'''
        {/* PACKET_STATE_STUB */}
        <PanelCard title="Packet State (stub)">
          <div style={{ display:"grid", gap:6, fontSize: 13, opacity: 0.9 }}>
            <div><span style={{ opacity: 0.7 }}>filingsMeta:</span> {incident?.filingsMeta ? "✅ present" : "—"}</div>
            <div><span style={{ opacity: 0.7 }}>timelineMeta:</span> {incident?.timelineMeta ? "✅ present" : "—"}</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              (Stub) This will become the canonical packet readiness panel.
            </div>
          </div>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor:"pointer", fontWeight: 900, opacity: 0.9 }}>View meta JSON</summary>
            <pre style={{ marginTop: 10, whiteSpace:"pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify({ filingsMeta: incident?.filingsMeta || null, timelineMeta: incident?.timelineMeta || null }, null, 2)}
            </pre>
          </details>
        </PanelCard>
'''
  # Insert after the "Timeline Meta" card (easy anchor)
  m = re.search(r'(<PanelCard title="Timeline Meta">[\s\S]*?</PanelCard>\s*)', s)
  if not m:
    raise SystemExit("❌ Could not find Timeline Meta panel anchor")
  s = s[:m.end()] + "\n" + panel + "\n" + s[m.end():]

p.write_text(s)
print("✅ added Packet State panel stub to incident page")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ done"
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
