#!/usr/bin/env bash
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

if "TIMELINE_PREVIEW_MOCK" not in s:
  block = r'''
      {/* TIMELINE_PREVIEW_MOCK */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          Timeline Preview (mock)
        </summary>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {[
            { t: "T+0", title: "Incident created", note: "Basic incident record exists." },
            { t: "T+5m", title: "Timeline generated", note: "Events ordered oldest → newest." },
            { t: "T+10m", title: "Filings generated", note: "DIRS / OE-417 / NORS / SAR / BABA payloads created." },
            { t: "T+15m", title: "Packet exported", note: "ZIP + hashes produced for audit." },
          ].map((x, i) => (
            <div key={i} style={{ border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)", borderRadius: 12, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>{x.title}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>{x.t}</div>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>{x.note}</div>
            </div>
          ))}
        </div>
      </details>
'''
  # insert just before the single footer line (Saved locally...)
  idx = s.find("Saved locally so techs don’t lose their place.")
  if idx == -1:
    raise SystemExit("❌ Could not find footer anchor in GuidedWorkflowPanel.tsx")
  # insert a bit above footer div
  anchor = s.rfind("\n      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}", 0, idx)
  if anchor == -1:
    raise SystemExit("❌ Could not find footer div block")
  s = s[:anchor] + block + "\n" + s[anchor:]

p.write_text(s)
print("✅ added Timeline Preview mock to GuidedWorkflowPanel")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ done"
