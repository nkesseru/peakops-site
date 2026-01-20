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

# 1) Remove any previously injected manifest blocks (all variants we've used)
patterns = [
  r"\n[ \t]*// Auto-generate manifest\.json[\s\S]*?zip\.file\(\s*['\"]manifest\.json['\"][\s\S]*?\);\s*\n",
  r"\n[ \t]*// Auto-generate manifest\.json[\s\S]*?__manifestFiles[\s\S]*?zip\.file\(\s*['\"]manifest\.json['\"][\s\S]*?\);\s*\n",
  r"\n[ \t]*const\s+__manifestFiles\s*:[\s\S]*?__manifestFiles\.sort\(\);[\s\S]*?zip\.file\(\s*['\"]manifest\.json['\"][\s\S]*?\);\s*\n",
]
for pat in patterns:
  s = re.sub(pat, "\n", s, flags=re.M)

# 2) Find where JSZip is instantiated INSIDE GET
#    We anchor on: const zip = new JSZip(...)
m = re.search(r"^([ \t]*)const\s+zip\s*=\s*new\s+JSZip\s*\([^;]*\)\s*;?\s*$", s, flags=re.M)
if not m:
  raise SystemExit("❌ Could not find `const zip = new JSZip(...)` in route.ts. Search for `new JSZip` and adjust anchor.")

indent = m.group(1)

manifest_block = f"""
{indent}// Auto-generate manifest.json from the zip contents.
{indent}// IMPORTANT: must run BEFORE hashes.json is generated so hashes include manifest.json.
{indent}const __manifestFiles: string[] = [];
{indent}zip.forEach((relPath, file) => {{
{indent}  // JSZip marks folders with `.dir`
{indent}  // @ts-ignore
{indent}  if (!(file as any).dir) __manifestFiles.push(String(relPath));
{indent}});
{indent}__manifestFiles.sort();

{indent}zip.file(
{indent}  "manifest.json",
{indent}  Buffer.from(
{indent}    JSON.stringify({{ packetVersion: "v1", generatedAt: __generatedAt, files: __manifestFiles }}, null, 2),
{indent}    "utf8"
{indent}  )
{indent});
"""

# Insert block AFTER the zip instantiation line
insert_at = m.end()
s = s[:insert_at] + "\n" + manifest_block + s[insert_at:]

p.write_text(s)
print("✅ cleaned + inserted manifest.json block right after `const zip = new JSZip()`")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke download route (HEAD)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$DURL" | head -n 25 || { echo "❌ still failing"; tail -n 220 .logs/next.log; exit 1; }

echo
echo "==> verify manifest.json exists inside downloaded zip"
TMP="/tmp/packet_manifest_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | grep -E "manifest\.json" || { echo "❌ manifest.json not found in zip"; exit 1; }
echo "✅ manifest.json present"

echo
echo "✅ DONE"
PY
