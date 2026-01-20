#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# If pill() already exists, do nothing.
if re.search(r'\bfunction\s+pill\s*\(', s) or re.search(r'\bconst\s+pill\s*=', s):
    print("ℹ️ pill() already exists — no changes needed.")
else:
    pill_fn = """
function pill(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
    userSelect: "none",
  };
}
""".strip()

    # Insert after the React import line (best anchor)
    m = re.search(r'^import\s+React[^\n]*\n', s, flags=re.M)
    if m:
        insert_at = m.end()
        s = s[:insert_at] + "\n" + pill_fn + "\n\n" + s[insert_at:]
        p.write_text(s)
        print("✅ inserted pill() helper after React import")
    else:
        # Fallback: insert at top after "use client";
        m2 = re.search(r'^"use client";\s*\n', s, flags=re.M)
        if m2:
            insert_at = m2.end()
            s = s[:insert_at] + "\n" + pill_fn + "\n\n" + s[insert_at:]
            p.write_text(s)
            print("✅ inserted pill() helper after use client")
        else:
            # Last resort: prepend
            p.write_text(pill_fn + "\n\n" + s)
            print("✅ prepended pill() helper (no anchor found)")

PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page loads"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi

echo "✅ DONE"
