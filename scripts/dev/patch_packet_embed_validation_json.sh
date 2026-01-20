#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -f "$ROOT/firebase.json" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -f "$ROOT/firebase.json" ]]; then
  echo "❌ Could not find repo root (firebase.json). Run from inside repo."
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ Missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
BAK="$ROOT/scripts/dev/_bak"
mkdir -p "$BAK"
cp "$FILE" "$BAK/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $BAK/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<PY
from pathlib import Path
import re

p = Path(r"$FILE")
s = p.read_text()

MARK = "/*__EMBED_VALIDATION_JSON_V1__*/"
if MARK in s:
    print("ℹ️ validation embed block already present (skipping patch)")
    raise SystemExit(0)

# We will insert the block RIGHT BEFORE hashes/manifest are computed.
# Anchor: the first occurrence of "const hashes" (your code already has this).
m = re.search(r"\n\s*// hashes\s*\+\s*manifest|\n\s*const\s+hashes\s*:", s)
if not m:
    raise SystemExit("❌ Could not find anchor near hashes/manifest section. Search for 'const hashes' and add anchor.")

block = f"""
{MARK}
// --- Schema validation (embed into packet) ---
// Pulls validation from our existing API route and stores it as filings/validation.json
try {{
  const vUrl = `${{origin}}/api/fn/validateIncidentFilingsV1?orgId=${{encodeURIComponent(orgId)}}&incidentId=${{encodeURIComponent(incidentId)}}`;
  const vRes = await fetch(vUrl, {{ method: "GET" }});
  const vTxt = await vRes.text();
  try {{
    const v = JSON.parse(vTxt || "{{}}");
    // Always store something deterministic in the packet:
    // - If API returns ok:false, we still embed the error payload for audit/debug.
    files.push({{ path: "filings/validation.json", bytes: utf8(JSON.stringify(v, null, 2)) }});
  }} catch {{
    // Non-JSON (rare) — still embed sample so the packet shows what happened.
    files.push({{
      path: "filings/validation.json",
      bytes: utf8(JSON.stringify({{
        ok: false,
        error: "validateIncidentFilingsV1 returned non-JSON",
        status: vRes.status,
        sample: (vTxt || "").slice(0, 500),
      }}, null, 2))
    }});
  }}
}} catch (e) {{
  files.push({{
    path: "filings/validation.json",
    bytes: utf8(JSON.stringify({{
      ok: false,
      error: "validateIncidentFilingsV1 fetch failed",
      message: String(getattr(e, "message", e)),
    }}, null, 2))
  }});
}}
"""

# Insert block at anchor
idx = m.start()
s = s[:idx] + block + "\n" + s[idx:]
p.write_text(s)
print("✅ patched route.ts: now embeds filings/validation.json into packet BEFORE hashes/manifest")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet + verify validation.json present"
TMP="/tmp/peak_packet_validation_${TS}"
mkdir -p "$TMP"

DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
curl -fsS "$DURL" -o "$TMP/packet.zip" || { echo "❌ download failed"; tail -n 160 "$ROOT/.logs/next.log"; exit 1; }

unzip -l "$TMP/packet.zip" | grep -q "filings/validation.json" || {
  echo "❌ filings/validation.json missing in packet.zip"
  unzip -l "$TMP/packet.zip" | head -n 120
  exit 2
}

echo "✅ filings/validation.json present"
echo
echo "--- filings/validation.json (first 220 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,220p'
echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "LOGS:"
echo "  tail -n 160 $ROOT/.logs/next.log"
