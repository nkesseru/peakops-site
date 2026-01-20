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

patterns = [
  r"\n\s*//\s*Auto-generate manifest\.json[\s\S]*?zip\.file\(\s*['\"]manifest\.json['\"][\s\S]*?\);\s*\n",
  r"\n\s*//\s*Auto-generate manifest\.json[\s\S]*?zip\.forEach\([\s\S]*?\);\s*\n",
  r"\n\s*const\s+__manifestFiles[\s\S]*?zip\.file\(\s*['\"]manifest\.json['\"][\s\S]*?\);\s*\n",
]
for pat in patterns:
  s = re.sub(pat, "\n", s, flags=re.M)
m = re.search(r"zip\.file\(\s*['\"]hashes\.json['\"]", s)
if not m:
  raise SystemExit("❌ Could not find `zip.file(\"hashes.json\" ...)` in downloadIncidentPacketZip route. Search for hashes.json and adjust script.")

manifest_block = """
  // Auto-generate manifest.json from the zip contents.
  // IMPORTANT: must run BEFORE hashes.json is generated so hashes include manifest.
  const __manifestFiles: string[] = [];
  zip.forEach((relPath, file) => {
    // JSZip uses `.dir` to indicate directories
    // @ts-ignore
    if (!(file as any).dir) __manifestFiles.push(String(relPath));
  });
  __manifestFiles.sort();

  zip.file(
    "manifest.json",
    Buffer.from(
      JSON.stringify({ packetVersion: "v1", generatedAt: __generatedAt, files: __manifestFiles }, null, 2),
      "utf8"
    )
  );
"""

s = s[:m.start()] + manifest_block + "\n" + s[m.start():]

p.write_text(s)
print("✅ patched: cleaned + reinserted manifest.json block before hashes.json")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke download route (HEAD)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$DURL" | head -n 25 || { echo "❌ still failing"; tail -n 220 .logs/next.log; exit 1; }

echo
echo "==> verify manifest.json exists inside downloaded zip"
TMP="/tmp/packet_manifest_smoke_$$"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | grep -E "manifest\.json" || { echo "❌ manifest.json not found in zip"; exit 1; }
echo "✅ manifest.json present"
echo
echo "✅ DONE"
