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

s = re.sub(r'style=$begin:math:text$\\s\*pill\\\(\(\.\*\?\)$end:math:text$\s*\)', r'style={pill(\1)}', s)
if not re.search(r'\bfunction\s+pill\s*\(', s):
    pill_fn = r'''
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
    cursor: "pointer",
    userSelect: "none",
  };
}
'''.lstrip("\n")

    # Try: insert after last import line
    m = None
    imports = list(re.finditer(r'^\s*import\s+.*?;\s*$', s, flags=re.M))
    if imports:
        m = imports[-1]
        insert_at = m.end()
        s = s[:insert_at] + "\n\n" + pill_fn + "\n" + s[insert_at:]
    else:
        # Fallback: put at top after "use client"
        m2 = re.search(r'^\s*"use client";\s*$', s, flags=re.M)
        if m2:
            insert_at = m2.end()
            s = s[:insert_at] + "\n\n" + pill_fn + "\n" + s[insert_at:]
        else:
            # Last resort: prepend
            s = pill_fn + "\n" + s

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: ensured pill() exists + normalized style usage")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page loads: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 160 .logs/next.log || true
  exit 1
fi

echo "✅ DONE"
