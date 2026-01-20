#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ route.ts not found: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$ROOT/scripts/dev/_bak" "$ROOT/.logs"
cp "$FILE" "$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

def strip_block(src: str, start: str, end: str) -> str:
  pat = re.compile(rf"{re.escape(start)}[\s\S]*?{re.escape(end)}\s*", re.M)
  return pat.sub("", src)

# 1) Remove the two broken embed blocks completely (V5 + V4)
s2 = s
s2 = strip_block(s2, "/*__VALIDATION_EMBED_V5__*/", "/*__VALIDATION_EMBED_V5_END__*/")
s2 = strip_block(s2, "/*__EMBED_VALIDATION_V4__*/", "/*__EMBED_VALIDATION_V4_END__*/")

# 2) Remove any stray poison patterns if they remain
# const __vUrl = \n  + \n ;
s2 = re.sub(r"^\s*const\s+__vUrl\s*=\s*\n\s*\+\s*\n\s*;\s*$", "", s2, flags=re.M)
s2 = re.sub(r"^\s*const\s+vUrl\s*=\s*\n\s*\+\s*\n\s*;\s*$", "", s2, flags=re.M)

# Also remove any leftover single '+' or ';' lines created by partial edits
s2 = re.sub(r"^\s*\+\s*$", "", s2, flags=re.M)
s2 = re.sub(r"^\s*;\s*$", "", s2, flags=re.M)

# 3) Ensure SAFE embed exists (it does in your snippet) — but if not, fail loudly
if "/*__VALIDATION_EMBED_SAFE_START__*/" not in s2 or "/*__VALIDATION_EMBED_SAFE_END__*/" not in s2:
  raise SystemExit("❌ SAFE validation block not found. (Expected /*__VALIDATION_EMBED_SAFE_START__*/ ... END)")

# 4) Ensure SAFE embed runs BEFORE hashes: it currently sits before `const hashes` in your snippet.
# Just sanity-check that ordering.
safe_pos = s2.find("/*__VALIDATION_EMBED_SAFE_START__*/")
hash_pos = re.search(r"^\s*const\s+hashes\s*:\s*Record<", s2, flags=re.M)
if not hash_pos:
  raise SystemExit("❌ Could not find `const hashes: Record<...` anchor.")
if safe_pos > hash_pos.start():
  raise SystemExit("❌ SAFE validation block is after hashes; move it above hashes.")

p.write_text(s2)
print("✅ cleaned route.ts: removed V5/V4 broken blocks; kept SAFE validation block")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet and verify validation files exist"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_validation_fix_${TS}"
mkdir -p "$TMP"

curl -fsS "$DURL" -o "$TMP/packet.zip" || {
  echo "❌ download failed"
  tail -n 220 "$ROOT/.logs/next.log" || true
  exit 1
}

unzip -l "$TMP/packet.zip" | grep -E "filings/(validation\.json|dirs\.validation\.json|oe417\.validation\.json)" >/dev/null || {
  echo "❌ validation files missing from zip"
  unzip -l "$TMP/packet.zip" | head -n 220
  exit 2
}

echo "✅ validation files present in packet.zip"
echo
echo "--- filings/validation.json (first 120 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,120p' || true

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
