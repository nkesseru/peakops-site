#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
if [ ! -f "$FILE" ]; then
  echo "❌ Missing file: $FILE"
  exit 1
fi

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
import re
from pathlib import Path

p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
s = p.read_text()
pretty_import = 'import PrettyJson from "../../_components/PrettyJson";\n'
if "PrettyJson" not in s:
    # Insert after "use client"; if present, else at top
    m = re.search(r'^\s*"use client";\s*\n', s, flags=re.M)
    if m:
        insert_at = m.end()
        s = s[:insert_at] + "\n" + pretty_import + s[insert_at:]
    else:
        s = pretty_import + s

pre_re = re.compile(
    r'(<pre[^>]*>\s*)\{[^}]*JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*,\s*null\s*,\s*2\s*\)[^}]*\}(\s*</pre>)',
    flags=re.S
)

m = pre_re.search(s)
if not m:
    # try looser (no null,2)
    pre_re2 = re.compile(
        r'(<pre[^>]*>\s*)\{[^}]*JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)[^}]*\}(\s*</pre>)',
        flags=re.S
    )
    m = pre_re2.search(s)

if not m:
    raise SystemExit("❌ Could not find a <pre> JSON.stringify(...) block to replace in contract detail page.")

var = m.group(2)

replacement = f'''<div style={{ display: "grid", gap: 10 }}>
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
    <div style={{ opacity: 0.7 }}>Contract #</div>
    <div style={{ fontWeight: 900 }}>{{
      String({var}?.contractNumber || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Type</div>
    <div style={{ fontWeight: 800 }}>{{
      String({var}?.type || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Status</div>
    <div style={{ fontWeight: 800 }}>{{
      String({var}?.status || "—")
    }}</div>
    <div style={{ opacity: 0.5 }}>·</div>
    <div style={{ opacity: 0.7 }}>Customer</div>
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{{
      String({var}?.customerId || "—")
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
    Tip: this is the source-of-truth contract object. Packet Preview is the “shareable artifact.”
  </div>
</div>'''

s = s[:m.start()] + replacement + s[m.end():]
p.write_text(s)
print(f"✅ patched {p} (replaced JSON.stringify({var}) pre-block with PrettyJson)")
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
