#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app

FILE="next-app/src/app/admin/contracts/[id]/payloads/page.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/contracts/[id]/payloads/page.tsx")
s = p.read_text()

if "href={`" in s and "payloads/" in s:
    print("ℹ️ payload list already link-based; skipping rewrite")
    exit(0)

# Replace simple list render with clickable cards
s = s.replace(
    "{docs.map((d) => (",
    "{docs.map((d) => (\n"
    "        <a key={d.id} href={`/admin/contracts/${contractId}/payloads/${d.id}?orgId=${orgId}`}\n"
    "           style={{ display:'block', padding:12, borderRadius:10, textDecoration:'none',"
    "                   border:'1px solid color-mix(in oklab, CanvasText 14%, transparent)',"
    "                   marginBottom:10 }}>\n"
)

s = s.replace("))}", "        </a>\n))}")

p.write_text(s)
print("✅ payload list patched with Apple-clean navigation")
PY

echo "✅ Restart Next:"
echo "  pkill -f \"next dev\" 2>/dev/null || true"
echo "  ( cd next-app && pnpm dev --port 3000 )"
