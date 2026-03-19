#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ Not found: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs
cp "$FILE" "scripts/dev/_bak/bundle_page_${TS}.tsx"
echo "✅ backup: scripts/dev/_bak/bundle_page_${TS}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

if re.search(r"\bgeneratedAt\s*:", s):
    print("⚠️ generatedAt already present in bundle page (no changes).")
    raise SystemExit(0)

m = re.search(r'packetHash\s*:\s*\{[^}]*\}', s)
if not m:
    # fallback: anchor on "Packet Meta" header
    m = re.search(r'Packet Meta', s)
    if not m:
        print("❌ Could not find anchor (packetHash or Packet Meta). Aborting.")
        raise SystemExit(1)
line_start = s.rfind("\n", 0, m.start()) + 1
line_end = s.find("\n", m.start())
if line_end == -1:
    line_end = len(s)
anchor_line = s[line_start:line_end]
indent = re.match(r"\s*", anchor_line).group(0)

inject = (
    f"{indent}<div style={{ fontSize: 12, opacity: 0.8 }}>\n"
    f"{indent}  generatedAt: {{\" \"}}\n"
    f"{indent}  <span style={{ fontFamily: \"ui-monospace\" }}>{{packetMeta?.generatedAt || \"—\"}}</span>\n"
    f"{indent}</div>\n"
)
s2 = s[:line_end+1] + inject + s[line_end+1:]

p.write_text(s2)
print("✅ patched: bundle page now displays generatedAt")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "==> smoke bundle page: $URL"
curl -fsS "$URL" >/dev/null \
  && echo "✅ bundle page OK" \
  || (echo "❌ bundle page failing"; tail -n 200 .logs/next.log; exit 1)

echo "OPEN:"
echo "  $URL"
