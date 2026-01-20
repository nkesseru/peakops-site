#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path('next-app/src/app/admin/incidents/[id]/page.tsx')
s = p.read_text()

# Remove any stray triple quotes that got injected
s = s.replace("'''", "").replace('"""', "")

# Hard-remove the entire injected workflow block (the usual troublemaker)
pat = re.compile(r"""
\{\s*/\*\s*Step\s+cards\s*\(Phase\s*2\)\s*\*/\s*\}      # marker comment
[\s\S]*?                                                # everything
\)\s*:\s*\(                                             # the ": (" of ternary
[\s\S]*?                                                # else branch
\)\s*\}                                                 # close ternary + }
""", re.X)

s2, n = pat.subn("", s, count=1)

# If not found, also try removing just the JSX wrapper near "No workflow steps"
if n == 0:
  pat2 = re.compile(r"\{\s*workflow\?\.[\s\S]*?No workflow steps\.[\s\S]*?\}\s*", re.M)
  s2, n = pat2.subn("", s, count=1)

p.write_text(s2)
print(f"✅ removed workflow block (matches={n})")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page compiles now" \
  || { echo "❌ still failing"; tail -n 80 .logs/next.log; exit 1; }
