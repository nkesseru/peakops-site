#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/BaselinePreview.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p=Path("next-app/src/app/admin/_components/BaselinePreview.tsx")
s=p.read_text()

# After baseline is computed/loaded, set window.WF_BASELINE_OK
# We'll inject a small snippet after we set state with fetched data.
if "WF_BASELINE_OK" not in s:
  # find a spot after a successful fetch parse (very loose anchor: setData or setBaseline)
  m = re.search(r'(set[A-Za-z0-9_]*\(\s*j\s*\)\s*;)', s)
  if not m:
    # fallback: after any "if (!j?.ok) throw"
    m = re.search(r'(if\s*\(!j\?\.(ok)\)\s*throw[\s\S]*?\n)', s)
  if not m:
    raise SystemExit("❌ Could not find a safe injection anchor in BaselinePreview.tsx")

  inject = "\n      try { (window as any).WF_BASELINE_OK = !!(j?.baselineOk or j?.valid or j?.okBaseline); } catch {}\n"
  # python doesn't know TS; we just place a conservative expression using JS ops:
  inject = "\n      try { (window as any).WF_BASELINE_OK = !!(j?.baselineOk || j?.valid || j?.okBaseline); } catch {}\n"

  s = s[:m.end()] + inject + s[m.end():]

p.write_text(s)
print("✅ patched BaselinePreview: sets window.WF_BASELINE_OK")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ done"
