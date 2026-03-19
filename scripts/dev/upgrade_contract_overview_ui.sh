#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/contracts/[id]/page.tsx"

if [ ! -f "$FILE" ]; then
  echo "❌ missing: $FILE"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
s = p.read_text()

# Ensure PrettyJson import exists (relative from contracts/[id] -> admin/_components)
if "PrettyJson" not in s:
  # Insert after "use client" block and before other imports
  s = re.sub(
    r'("use client";\s*\n)',
    r'\1\nimport PrettyJson from "../../_components/PrettyJson";\n',
    s,
    count=1
  )

# Replace the "Overview" panel content
# We look for the PanelCard titled "Overview" and replace its children.
pattern = re.compile(
  r'(<PanelCard\s+title="Overview"\s*>\s*)(.*?)(\s*</PanelCard>)',
  re.S
)

m = pattern.search(s)
if not m:
  raise SystemExit("❌ Could not find <PanelCard title=\"Overview\"> block to patch.")

replacement_body = r'''
{contract ? (
  <div style={{ display: "grid", gap: 12 }}>
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
      gap: 10,
      alignItems: "stretch"
    }}>
      {[
        ["Contract #", contract.contractNumber || "—"],
        ["Status", contract.status || "—"],
        ["Type", contract.type || "—"],
        ["Customer", contract.customerId || "—"],
        ["Updated", (contract.updatedAt && (typeof contract.updatedAt === "string"
          ? new Date(contract.updatedAt).toLocaleString()
          : (contract.updatedAt._seconds ? new Date(contract.updatedAt._seconds * 1000).toLocaleString() : String(contract.updatedAt)
        ))) || "—"],
      ].map(([k, v]) => (
        <div key={String(k)} style={{
          border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
          borderRadius: 14,
          padding: 10,
          background: "color-mix(in oklab, CanvasText 3%, transparent)",
          minHeight: 64
        }}>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{k}</div>
          <div style={{ fontWeight: 900, marginTop: 4, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {String(v)}
          </div>
        </div>
      ))}
    </div>

    <details style={{ border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius: 14, padding: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
        Raw contract JSON
      </summary>
      <div style={{ marginTop: 10 }}>
        <PrettyJson value={contract} />
      </div>
    </details>
  </div>
) : (
  <div style={{ opacity: 0.75 }}>—</div>
)}
'''

new_block = m.group(1) + replacement_body + m.group(3)
s2 = s[:m.start()] + new_block + s[m.end():]
p.write_text(s2)

print("✅ Patched Contract Overview UI (grid + collapsible PrettyJson)")
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
