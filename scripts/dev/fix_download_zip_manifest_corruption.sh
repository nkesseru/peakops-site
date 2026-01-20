#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()
s2, n = re.subn(
    r"""
    const\ zipBytes\s*=\s*await\s*        # 'const zipBytes = await' (possibly with whitespace/newline)
    \s*\n                                # newline
    /\*__AUTO_MANIFEST_V1__\*/           # marker
    [\s\S]*?                             # anything
    zip\.generateAsync\([^\)]*\);\s*     # the stray generateAsync(...) call
    """,
    "const zipBytes = await zip.generateAsync({ type: \"uint8array\", compression: \"DEFLATE\" });\n",
    s,
    flags=re.X,
)
if n == 0:
    # If the marker block isn't found, still ensure the correct generateAsync line exists.
    # Fix common partial corruption: "const zipBytes = await" followed later by "zip.generateAsync(...);"
    s2 = re.sub(
        r"const zipBytes\s*=\s*await\s*\n\s*zip\.generateAsync\(",
        "const zipBytes = await zip.generateAsync(",
        s2,
        flags=re.M,
    )
s2 = re.sub(r"/\*__AUTO_MANIFEST_V1__\*/[\s\S]*?zip\.generateAsync\([^\)]*\);\s*", "", s2)
parts = s2.split("zip.generateAsync(")
if len(parts) > 2:
    # reconstruct keeping only first generateAsync occurrence
    head = parts[0] + "zip.generateAsync(" + parts[1]
    # drop remaining generateAsync occurrences by replacing them with a comment
    tail = "zip.generateAsync(".join(parts[2:])
    tail = re.sub(r"^.*", "", tail)
    s2 = head

p.write_text(s2)
print("✅ fixed downloadIncidentPacketZip: removed corrupted manifest injection + restored await zip.generateAsync(...)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke download route (HEAD)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"
curl -fsSI "$DURL" | head -n 30

echo
echo "==> verify manifest.json present inside zip"
TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | grep -E "manifest\.json|hashes\.json|packet_meta\.json" || {
  echo "❌ expected files not found in zip listing"
  exit 1
}
echo "✅ zip contains manifest.json + hashes.json + packet_meta.json"

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ DONE"
