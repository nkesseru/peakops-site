#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_generatedAt_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_generatedAt_*"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# 1) Remove any literal "\n" tokens that were injected by prior scripts
s = s.replace("\\n", "")

# 2) Hard replace the known bad literal date
s = s.replace("2000-01-01T00:00:00.000Z", '" + new Date().toISOString() + "')

# 3) Ensure we have a generatedAt variable inside the handler
if "const generatedAt = new Date().toISOString()" not in s:
    needle = "export async function"
    idx = s.find(needle)
    if idx == -1:
        raise SystemExit("❌ could not find handler to inject generatedAt")
    # insert generatedAt right after function signature line break
    line_end = s.find("\n", idx)
    if line_end == -1:
        raise SystemExit("❌ unexpected formatting for handler")
    inject = "\n  const generatedAt = new Date().toISOString();\n"
    s = s[:line_end+1] + inject + s[line_end+1:]

# 4) Normalize x-peakops-generatedat to use generatedAt variable if present as a literal concat
# We do this with safe string replacements only (no regex).
s = s.replace('res.setHeader("x-peakops-generatedat", "',
              'res.setHeader("x-peakops-generatedat", ')
# If it became invalid (missing quotes), ensure correct setHeader call exists.
if 'res.setHeader("x-peakops-generatedat", generatedAt);' not in s:
    # try to convert common patterns
    s = s.replace('res.setHeader("x-peakops-generatedat", " + new Date().toISOString() + ");',
                  'res.setHeader("x-peakops-generatedat", generatedAt);')
    s = s.replace('res.setHeader("x-peakops-generatedat", " + new Date().toISOString() + ");',
                  'res.setHeader("x-peakops-generatedat", generatedAt);')
    # last resort: if header exists but not correct, leave it; we’ll still have the literal replaced.

p.write_text(s)
print("✅ patched: downloadIncidentPacketZip generatedAt now dynamic")
PY

echo "🧹 restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "==> prove headers (NO pipes, avoid zsh weirdness)"
curl -I -sS "http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" \
  | awk 'BEGIN{IGNORECASE=1} /HTTP\/|content-type|content-disposition|x-peakops-generatedat|x-peakops-zip-sha256|x-peakops-zip-size|x-peakops-packethash/ {print}'

echo
echo "LOGS:"
tail -n 40 "$LOGDIR/next.log" || true
