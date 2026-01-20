#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

if "PACKET_STATE_STUB" in s:
    print("ℹ️ Packet State stub already present (skipping)")
    raise SystemExit(0)

panel = r'''
        {/* PACKET_STATE_STUB */}
        <Panel title="Packet State (stub)">
          <div style={{ display:"grid", gap:6, fontSize: 13, opacity: 0.9 }}>
            <div><span style={{ opacity: 0.7 }}>filingsMeta:</span> {incident?.filingsMeta ? "✅ present" : "—"}</div>
            <div><span style={{ opacity: 0.7 }}>timelineMeta:</span> {incident?.timelineMeta ? "✅ present" : "—"}</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              (Stub) This becomes the canonical packet readiness panel.
            </div>
          </div>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor:"pointer", fontWeight: 900, opacity: 0.9 }}>
              View meta JSON
            </summary>
            <pre style={{ marginTop: 10, whiteSpace:"pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify({ filingsMeta: incident?.filingsMeta || null, timelineMeta: incident?.timelineMeta || null }, null, 2)}
            </pre>
          </details>
        </Panel>
'''

# Prefer inserting AFTER Evidence Locker Panel
anchors = [
    r'(<Panel\s+title="Evidence Locker">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Filing Meta">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Timeline">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Guided Workflow">[\s\S]*?</Panel>\s*)',
]

m = None
for pat in anchors:
    m = re.search(pat, s)
    if m:
        break

if not m:
    # Fallback: insert right after the GuidedWorkflowPanel render if present
    m = re.search(r'(<GuidedWorkflowPanel\b[\s\S]*?/\>\s*)', s)

if not m:
    raise SystemExit("❌ Could not find a safe anchor (Panel title=..., or GuidedWorkflowPanel).")

s = s[:m.end()] + "\n" + panel + "\n" + s[m.end():]
p.write_text(s)
print("✅ inserted Packet State stub")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ incident page OK" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log
  exit 1
}

echo "✅ done"
echo "OPEN: $URL"
