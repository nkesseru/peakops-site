#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

if [ ! -f "$FILE" ]; then
  echo "❌ Missing file: $FILE"
  exit 1
fi

cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

MARK = "/*__AUTO_MANIFEST_V1__*/"
if MARK in s:
  print("ℹ️ manifest autogen already present (skipping)")
  raise SystemExit(0)

manifest_block = f"""
{MARK}
// Auto-generate manifest.json from the actual zip contents.
// IMPORTANT: must run BEFORE hashes.json is generated so hashes include manifest.
const __manifestFiles: string[] = [];
zip.forEach((relPath: string, f: any) => {{
  if (!f.dir) __manifestFiles.push(relPath);
}});
__manifestFiles.sort();

const __generatedAt = new Date().toISOString();
zip.file(
  "manifest.json",
  Buffer.from(JSON.stringify({{ packetVersion: "v1", generatedAt: __generatedAt, files: __manifestFiles }}, null, 2), "utf8")
);
"""

# Prefer inserting BEFORE hashes.json generation (so hashes include manifest.json)
# Look for the first occurrence of writing hashes.json
m = re.search(r'zip\.file\(\s*["\']hashes\.json["\']', s)
if m:
  s = s[:m.start()] + manifest_block + "\n" + s[m.start():]
  print("✅ inserted manifest block before hashes.json write")
else:
  # fallback: insert before zip.generateAsync(...)
  m2 = re.search(r'zip\.generateAsync\(', s)
  if not m2:
    raise SystemExit("❌ Could not find insertion point (no hashes.json write, no generateAsync). Search in file for 'hashes.json' or 'generateAsync'.")
  s = s[:m2.start()] + manifest_block + "\n" + s[m2.start():]
  print("✅ inserted manifest block before zip.generateAsync (fallback)")

p.write_text(s)
print("✅ patched downloadIncidentPacketZip: manifest.json auto-generated")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke download headers"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$DURL" | head -n 25

echo
echo "==> quick verify manifest exists inside zip (download + unzip)"
TMP="/tmp/packet_manifest_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | grep -E "manifest.json" || { echo "❌ manifest.json not found in zip"; exit 1; }
echo "✅ manifest.json present"

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
