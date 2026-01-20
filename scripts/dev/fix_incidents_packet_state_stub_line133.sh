#!/usr/bin/env bash
set +H 2>/dev/null || true
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
s2 = re.sub(
  r'<Panel\s+title="Packet State\s*\(stub\)">\s*[\s\S]*?</Panel>\s*',
  '',
  s,
  count=1
)
block = r'''
<Panel title="Packet State (stub)">
  <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
    <div>
      <span style={{ opacity: 0.7 }}>filingsMeta:</span>{" "}
      {wf?.incident?.filingsMeta ? "✅ present" : "—"}
    </div>
    <div>
      <span style={{ opacity: 0.7 }}>timelineMeta:</span>{" "}
      {wf?.incident?.timelineMeta ? "✅ present" : "—"}
    </div>
    <div style={{ fontSize: 12, opacity: 0.75 }}>
      (Stub) This becomes the canonical packet readiness panel.
    </div>

    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
        View meta JSON
      </summary>
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
'''.strip()
anchor = re.search(r'<Panel\s+title="Guided Workflow">\s*[\s\S]*?</Panel>', s2)
if not anchor:
  raise SystemExit("❌ Could not find Guided Workflow <Panel ...> block to anchor Packet State insertion.")

insert_pos = anchor.end()
s3 = s2[:insert_pos] + "\n\n" + block + "\n\n" + s2[insert_pos:]

p.write_text(s3)
print("✅ Packet State stub replaced cleanly")
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
