#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

echo "==> patching $FILE"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
s = s.replace(
  '<Button disabled={ onClick={() => hv && navigator.clipboard?.writeText(hv)}>Copy hash</Button>',
  '<Button disabled={!hv} onClick={() => hv && navigator.clipboard?.writeText(hv)}>Copy hash</Button>'
)

# Also cover a common variant with optional chaining spacing
s = s.replace(
  '<Button disabled={ onClick={() => hv && navigator.clipboard?.writeText(hv)}>',
  '<Button disabled={!hv} onClick={() => hv && navigator.clipboard?.writeText(hv)}>'
)

s = re.sub(r"<div\s*\n\s*style=", "<div style=", s)
s = s.replace("heredoc>", "")

p.write_text(s)
print("✅ ui evidence panel patched")
PY

echo "==> quick view around Evidence Locker (for sanity)"
nl -ba "$FILE" | sed -n '740,810p' || true

echo "✅ Done. Restart next-app."
