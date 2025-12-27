#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Insert missing close for: {showAttention && ( ... </PanelCard> )}
# specifically when the next thing is the Evidence Locker <div style={{ marginTop: 16 }}>
pat = r'(showAttention\s*&&\s*\(\s*\n.*?<PanelCard title="What Needs Attention">.*?</PanelCard>\s*)(\n\s*<div\s+style=\{\{\s*marginTop:\s*16\s*\}\}\s*>\s*\n\s*<PanelCard title="Evidence Locker">)'

m = re.search(pat, s, flags=re.S)
if not m:
  raise SystemExit("❌ Pattern not found. The file may have changed; paste lines 740-780 if this happens.")

block1 = m.group(1)
block2 = m.group(2)

# If it's already closed, don't double-insert
if re.search(r'</PanelCard>\s*\)\}\s*$', block1.strip(), flags=re.S):
  print("✅ already has )} after What Needs Attention")
else:
  block1 = re.sub(r'(</PanelCard>\s*)$', r'\1\n        )}\n', block1)
  s = s[:m.start()] + block1 + block2 + s[m.end():]
  p.write_text(s)
  print("✅ inserted missing )} after What Needs Attention block")
PY

echo "==> show the area"
nl -ba "$FILE" | sed -n '740,790p' || true
