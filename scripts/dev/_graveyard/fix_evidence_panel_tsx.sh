#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

# bracket path needs quoting/escaping for zsh
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
cp -v "$FILE" "${FILE}.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

start = s.find('<PanelCard title="Evidence Locker"')
if start == -1:
    start = s.find("<PanelCard title='Evidence Locker'")
if start == -1:
    raise SystemExit("❌ Could not find Evidence Locker PanelCard in page.tsx")

end = s.find("</PanelCard>", start)
if end == -1:
    raise SystemExit("❌ Found Evidence Locker start but no closing </PanelCard>")

end = end + len("</PanelCard>")

replacement = """<PanelCard title="Evidence Locker">
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
    <Button disabled={!!busy} onClick={loadEvidenceLocker}>Refresh Evidence</Button>
  </div>
</PanelCard>"""

s2 = s[:start] + replacement + s[end:]
p.write_text(s2)
print("✅ Replaced Evidence Locker panel block with valid TSX.")
PY

echo "==> quick sanity (shows the edited area)"
nl -ba "$FILE" | sed -n '750,790p'

echo "✅ done"
