#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PAGE="$ROOT/next-app/src/app/admin/incidents/[id]/page.tsx"

if [[ ! -f "$PAGE" ]]; then
  echo "❌ Missing file: $PAGE"
  exit 1
fi

cp "$PAGE" "$PAGE.bak_btnfix_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_btnfix_*"

python3 <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# If btn() already exists, do nothing
if re.search(r'\bfunction\s+btn\s*\(', s) or re.search(r'\bconst\s+btn\s*=', s):
    print("ℹ️ btn() helper already present — skipping")
    raise SystemExit(0)

btn_helper = r'''
function btn(primary: boolean): React.CSSProperties {
  return {
    border: "1px solid rgba(255,255,255,0.14)",
    background: primary ? "rgba(34,197,94,0.18)" : "rgba(255,255,255,0.06)",
    color: "inherit",
    padding: "9px 12px",
    borderRadius: 999,
    fontWeight: 800,
    fontSize: 12,
    cursor: "pointer",
    opacity: 1,
  };
}

'''

# Insert after imports
m = re.search(r'(import[\s\S]+?\n)\n', s)
if not m:
    raise SystemExit("❌ Could not find import block to insert btn()")

s = s[:m.end()] + btn_helper + s[m.end():]
p.write_text(s)

print("✅ injected btn() helper into incident page")
PY

echo "🧹 restarting Next"
mkdir -p "$ROOT/.logs"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf "$ROOT/next-app/.next" 2>/dev/null || true
( cd "$ROOT/next-app" && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke test"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5 || true

echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
