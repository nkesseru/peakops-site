#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
[[ -d "$ROOT/next-app" ]] || { echo "❌ cannot find repo root (needs next-app/)"; exit 1; }

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
[[ -f "$FILE" ]] || { echo "❌ missing $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
BAK="$ROOT/scripts/dev/_bak"
mkdir -p "$BAK"
cp "$FILE" "$BAK/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $BAK/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<PY
from pathlib import Path
import re

p = Path("$FILE")
s = p.read_text()

# -------------------------------------------------------------------
# (1) Remove the broken embed-validation block that causes:
#     const vUrl = ;
# We delete from the comment line above it (if present) through the end
# of that try/catch block (best-effort, safe).
# -------------------------------------------------------------------
if "const vUrl = ;" in s:
    # Try to remove a block that starts at the embed comment near it.
    start = s.rfind("Pulls validation", 0, s.find("const vUrl = ;"))
    if start == -1:
        # fallback: start at the "try {" right before const vUrl
        start = s.rfind("try {", 0, s.find("const vUrl = ;"))
    end = s.find("} catch", s.find("const vUrl = ;"))
    if end != -1:
        # extend to end of that catch block
        end2 = s.find("}", end)
        # eat a bit more safely (next brace)
        end3 = s.find("}", end2+1) if end2 != -1 else -1
        cut_end = end3+1 if end3 != -1 else end2+1 if end2 != -1 else end
        s = s[:start] + "\n" + s[cut_end:]
    else:
        # if we can't find a clean end, just remove the bad line
        s = s.replace("const vUrl = ;", "// (removed broken const vUrl)")

# -------------------------------------------------------------------
# (2) Insert a clean embed-validation block BEFORE hashes/manifest loop.
# We anchor right before: "for (const f of files) {"
# -------------------------------------------------------------------
anchor = "for (const f of files) {"
idx = s.find(anchor)
if idx == -1:
    raise SystemExit("❌ Could not find anchor 'for (const f of files) {' in route.ts")

# Avoid double-insert
if "__EMBED_VALIDATION_V4__" not in s:
    block = r'''
    /*__EMBED_VALIDATION_V4__*/
    // Pull schema validation from our existing API route and store it as filings/validation.json
    // This must run BEFORE hashes/manifest are computed so hashes include validation.json
    try {
      const vUrl =
        `${origin}/api/fn/validateIncidentFilingsV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const vRes = await fetch(vUrl, { method: "GET" });
      const vTxt = await vRes.text();

      // If it isn't JSON, we still stash a small error object so the packet stays deterministic.
      let vObj: any = null;
      try {
        vObj = JSON.parse(vTxt || "{}");
      } catch {
        vObj = { ok: false, error: "validation route returned non-JSON", status: vRes.status, sample: (vTxt || "").slice(0, 220) };
      }

      files.push({
        path: "filings/validation.json",
        bytes: utf8(JSON.stringify(vObj, null, 2)),
      });
    } catch (e: any) {
      files.push({
        path: "filings/validation.json",
        bytes: utf8(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2)),
      });
    }
    /*__EMBED_VALIDATION_V4_END__*/

'''
    s = s[:idx] + block + s[idx:]

p.write_text(s)
print("✅ patched route.ts: embed filings/validation.json (V4) + removed broken vUrl")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet + verify filings/validation.json exists"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_packet_validation_${TS}"
mkdir -p "$TMP"

curl -fsS "$DURL" -o "$TMP/packet.zip" || {
  echo "❌ download failed"
  tail -n 200 "$ROOT/.logs/next.log"
  exit 1
}

unzip -l "$TMP/packet.zip" | grep -q "filings/validation.json" || {
  echo "❌ filings/validation.json missing in packet.zip"
  unzip -l "$TMP/packet.zip" | head -n 160
  exit 2
}

echo "✅ filings/validation.json present"
echo
echo "--- filings/validation.json (first 120 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,120p'

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 200 $ROOT/.logs/next.log"
