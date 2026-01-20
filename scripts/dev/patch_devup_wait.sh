#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="scripts/dev/dev-up.sh"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup created"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("scripts/dev/dev-up.sh")
s = p.read_text()

# Add helper only once
helper = r'''
wait_fn() {
  local url="$1"
  local tries="${2:-40}"
  local sleep_s="${3:-0.25}"
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}
'''

if "wait_fn()" not in s:
  # Insert helper near top after set -e... line
  s = re.sub(r'(set -euo pipefail\s*\n)', r'\1' + helper + '\n', s, count=1)

# Replace the brittle smoke block (best-effort, only if the marker lines exist)
# We look for "wait for functions /hello" line and ensure we actually wait, then retry listIncidents.
s = s.replace(
  'echo "==> wait for functions /hello"\n',
  'echo "==> wait for functions /hello"\n'
  'wait_fn "$FN_BASE/hello" 80 0.25 || { echo "❌ hello never came up"; exit 1; }\n'
)

# If smoke listIncidents is immediate, make it retry and not hard-fail.
s = s.replace(
  'echo "==> smoke: listIncidents"\n'
  'curl -sS "$FN_BASE/listIncidents?orgId=$ORG_ID" | python3 -m json.tool\n',
  'echo "==> smoke: listIncidents"\n'
  'wait_fn "$FN_BASE/listIncidents?orgId=$ORG_ID" 80 0.25 || { echo "❌ listIncidents still 404 after waiting"; exit 1; }\n'
  'curl -sS "$FN_BASE/listIncidents?orgId=$ORG_ID" | python3 -m json.tool\n'
)

p.write_text(s)
print("✅ patched scripts/dev/dev-up.sh")
PY

echo "✅ now run: bash scripts/dev/dev-up.sh"
