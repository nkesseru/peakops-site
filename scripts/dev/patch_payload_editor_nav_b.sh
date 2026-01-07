#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app

FILE="next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$ts"
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx")
s = p.read_text()

if "Back to Payloads" in s:
    print("ℹ️ editor nav already present; skipping")
    exit(0)

inject = """
      <div style={{ display:'flex', gap:10, marginBottom:12 }}>
        <a href={`/admin/contracts/${contractId}/payloads?orgId=${orgId}`}
           style={{ opacity:0.8 }}>← Back to Payloads</a>
        <a href={`/admin/contracts/${contractId}?orgId=${orgId}`}
           style={{ opacity:0.8 }}>Contract Overview</a>
      </div>
"""

s = s.replace("<div style={{ marginBottom: 8 }}>", inject + "\n<div style={{ marginBottom: 8 }}>")

p.write_text(s)
print("✅ payload editor navigation added")
PY

echo "✅ Restart Next:"
echo "  pkill -f \"next dev\" 2>/dev/null || true"
echo "  ( cd next-app && pnpm dev --port 3000 )"
