#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"

if [[ ! -f "$FILE" ]]; then
  echo "❌ route.ts not found: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

if "validation.json" in s:
    print("⚠️ validation already present, skipping")
    raise SystemExit(0)

insert_anchor = "files.push({ path: \"manifest.json\""
idx = s.find(insert_anchor)
if idx == -1:
    raise SystemExit("❌ Could not find manifest.json insertion point")

block = """
    // --- schema validation (DIRS + OE_417) ---
    try {
      const vUrl = `${origin}/api/fn/validateIncidentFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const vRes = await fetch(vUrl);
      const vText = await vRes.text();
      const vJson = safeJson(vText);

      files.push({
        path: "filings/validation.json",
        bytes: utf8(
          JSON.stringify(
            vJson.ok ? vJson.v : { ok: false, error: vText.slice(0, 200) },
            null,
            2
          )
        ),
      });
    } catch (e) {
      files.push({
        path: "filings/validation.json",
        bytes: utf8(
          JSON.stringify(
            { ok: false, error: String(e) },
            null,
            2
          )
        ),
      });
    }
"""

s = s[:idx] + block + "\n" + s[idx:]
p.write_text(s)
print("✅ patched packet ZIP to include filings/validation.json")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: download packet + check validation.json"
TMP="/tmp/packet_validation_smoke_$TS"
mkdir -p "$TMP"

DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsS "$DURL" -o "$TMP/packet.zip" || { echo "❌ download failed"; exit 1; }

unzip -l "$TMP/packet.zip" | grep "filings/validation.json" \
  && echo "✅ validation.json present in packet" \
  || { echo "❌ validation.json missing"; exit 1; }

echo
echo "--- validation.json ---"
unzip -p "$TMP/packet.zip" filings/validation.json | sed -n '1,200p'

echo
echo "✅ DONE"
echo "Artifacts:"
echo "  $TMP/packet.zip"
