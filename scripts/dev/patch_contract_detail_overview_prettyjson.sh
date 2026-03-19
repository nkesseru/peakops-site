#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
test -f "$FILE" || { echo "❌ Missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
s = p.read_text()

imp = 'import PrettyJson from "../../_components/PrettyJson";\n'
if "PrettyJson" not in s:
    m = re.search(r'^\s*"use client";\s*\n', s, flags=re.M)
    if m:
        s = s[:m.end()] + "\n" + imp + s[m.end():]
    else:
        s = imp + s

candidates = ["doc", "contract", "j?.doc", "j.doc", "data?.doc", "data.doc"]
var = None
for c in candidates:
    if c in s:
        var = c
        break
if not var:
    m = re.search(r'const\s+\[\s*(doc|contract)\s*,\s*set\w+\s*\]', s)
    if m:
        var = m.group(1)
if not var:
    var = "doc"
anchor = 'Overview'
idx = s.find(anchor)
if idx == -1:
    raise SystemExit('❌ Could not find "Overview" text in contract detail page.')
after = s[idx:]
div_start = after.find("<div")
if div_start == -1:
    raise SystemExit("❌ Could not find a <div after Overview header to patch.")

start = idx + div_start
chunk = s[start:start+3000]
m_end = re.search(r'</div>\s*\n\s*</div>', chunk)
end_rel = m_end.end() if m_end else None
if not end_rel:
    # fallback: just find first '</div>' after start and use that
    end_rel = chunk.find("</div>") + len("</div>")
    if end_rel < len("</div>"):
        raise SystemExit("❌ Could not locate end of Overview block to patch.")

end = start + end_rel

replacement = f'''<div style={{ display: "grid", gap: 10 }}>
  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
    <div style={{ opacity: 0.7 }}>Contract #</div>
    <div style={{ fontWeight: 900 }}>{{
      String(({var} as any)?.contractNumber || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Type</div>
    <div style={{ fontWeight: 800 }}>{{
      String(({var} as any)?.type || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Status</div>
    <div style={{ fontWeight: 800 }}>{{
      String(({var} as any)?.status || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Customer</div>
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{{
      String(({var} as any)?.customerId || "—")
    }}</div>
  </div>

  <div style={{
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 12,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  }}>
    <PrettyJson value={{{var} || {{}}}} collapsed={{2}} />
  </div>

  <div style={{ fontSize: 12, opacity: 0.65 }}>
    Tip: this is the live contract object. Packet Preview is the “shareable artifact.”
  </div>
</div>'''

s2 = s[:start] + replacement + s[end:]
p.write_text(s2)
print(f"✅ patched {p} (Overview now uses PrettyJson, var={var})")
PY

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "✅ Next restarted"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
