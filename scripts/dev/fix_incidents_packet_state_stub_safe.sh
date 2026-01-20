#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE='next-app/src/app/admin/incidents/[id]/page.tsx'
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Replace ANY existing PACKET_STATE_STUB block with a clean one
stub = r"""
{/* PACKET_STATE_STUB */}
<Panel title="Packet State (stub)">
  <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
    <div><span style={{ opacity: 0.7 }}>filingsMeta:</span> {wf?.incident?.filingsMeta ? "present" : "—"}</div>
    <div><span style={{ opacity: 0.7 }}>timelineMeta:</span> {wf?.incident?.timelineMeta ? "present" : "—"}</div>
    <div style={{ fontSize: 12, opacity: 0.75 }}>
      (Stub) This becomes the canonical packet readiness panel.
    </div>

    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>View meta JSON</summary>
      <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify(
  {
    filingsMeta: wf?.incident?.filingsMeta || null,
    timelineMeta: wf?.incident?.timelineMeta || null,
  },
  null,
  2
)}
      </pre>
    </details>
  </div>
</Panel>
""".strip()

# If marker exists, replace from marker to the end of the </Panel> that follows it.
m = re.search(r"\{\s*/\*\s*PACKET_STATE_STUB\s*\*/\s*\}[\s\S]*?</Panel>", s)
if not m:
    raise SystemExit("❌ Could not find PACKET_STATE_STUB block in file. (Search for it and insert marker first.)")

s = s[:m.start()] + stub + s[m.end():]
p.write_text(s)
print("✅ replaced PACKET_STATE_STUB with clean JSX")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}
