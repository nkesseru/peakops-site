#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
[[ -f "$PAGE" ]] || { echo "❌ missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_ui409_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_ui409_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Add a helper to map IMMUTABLE 409 into a friendly message (idempotent)
if "function isImmutable409" not in s:
    helper = r'''
function isImmutable409(status: number, bodyText: string) {
  return status === 409 && (bodyText || "").includes("IMMUTABLE");
}
'''
    # insert after btn() if present, else after imports
    m = re.search(r'function\s+btn\s*\([^)]*\)\s*:\s*React\.CSSProperties\s*\{[\s\S]*?\n\}\n', s)
    if m:
        s = s[:m.end()] + "\n" + helper + "\n" + s[m.end():]
    else:
        m2 = re.search(r'(import[\s\S]+?\n)\n', s)
        if not m2:
            raise SystemExit("❌ could not find import block to insert helper")
        s = s[:m2.end()] + helper + "\n" + s[m2.end():]

# 2) Patch runAction fetch handling: if 409 IMMUTABLE, show nice message and stop
# We'll find `const r = await fetch(` in runAction and wrap response handling.
# This is heuristic but safe because we only add handling, not remove.
if "IMMUTABLE: Incident is finalized" not in s:
    s = re.sub(
        r'(const\s+r\s*=\s*await\s+fetch\([^;]+;\s*\n\s*const\s+t\s*=\s*await\s+r\.text\(\)\s*;)',
        r'''\1

      if (isImmutable409(r.status, t)) {
        setErr("Locked: this incident is finalized (immutable). You can only Export with force=1 (admin).");
        setBusy("");
        return;
      }
''',
        s,
        count=1,
        flags=re.M
    )

p.write_text(s)
print("✅ patched UI: handle 409 IMMUTABLE nicely")
PY

echo "🧹 restart Next"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true
echo "LOGS: tail -n 120 .logs/next.log"
