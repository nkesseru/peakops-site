#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do
  ROOT="$(dirname "$ROOT")"
done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ route.ts not found at: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
BAK="$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
mkdir -p "$ROOT/scripts/dev/_bak"
cp "$FILE" "$BAK"
echo "✅ backup: $BAK"

python3 - <<PY
from pathlib import Path
import re

p = Path(r"$FILE")
s = p.read_text()

# 1) Remove any prior marker-based block we might have inserted
s = re.sub(r"/\\*__VALIDATION_EMBED_V5__\\*/[\\s\\S]*?/\\*__VALIDATION_EMBED_V5_END__\\*/\\s*", "", s)

# 2) Remove older/broken attempts that started with these comments (best-effort)
#    This cleans up the mess that caused:
#    - const vUrl = ;
#    - dangling ", null, 2))"
patterns = [
  r"//\\s*---\\s*Schema\\s*validation[\\s\\S]*?\\}\\s*catch\\s*\\(e\\)\\s*\\{[\\s\\S]*?\\}\\s*\\n",
  r"//\\s*Pulls\\s+validation[\\s\\S]*?\\}\\s*catch\\s*\\(e\\)\\s*\\{[\\s\\S]*?\\}\\s*\\n",
]
for pat in patterns:
  s = re.sub(pat, "", s)

# 3) Also remove the exact "const vUrl = ;" line if present
s = re.sub(r"^\\s*const\\s+vUrl\\s*=\\s*;\\s*$\\n?", "", s, flags=re.M)

# 4) Find a safe insertion point: right BEFORE the hashes computation.
m = re.search(r"^\\s*const\\s+hashes\\s*:\\s*Record<", s, flags=re.M)
if not m:
  # fallback: any const hashes =
  m = re.search(r"^\\s*const\\s+hashes\\s*=", s, flags=re.M)
if not m:
  raise SystemExit("❌ Could not find a hashes anchor (const hashes...) in route.ts")

insert_at = m.start()

block = r"""
/*__VALIDATION_EMBED_V5__*/
// Embed schema validation into packet as filings/validation.json.
// Safe: if validator route fails/non-JSON, we store a diagnostic object and still build the packet.
try {
  const __vUrl =
    `${origin}/api/fn/validateIncidentFilingsV1?orgId=${encodeURIComponent(orgId)}` +
    `&incidentId=${encodeURIComponent(incidentId)}`;
  const __vRes = await fetch(__vUrl, { method: "GET" });
  const __vTxt = await __vRes.text();

  let __v: any;
  try {
    __v = JSON.parse(__vTxt || "{}");
  } catch {
    __v = {
      ok: false,
      error: "validateIncidentFilingsV1 returned non-JSON",
      status: __vRes.status,
      sample: (__vTxt || "").slice(0, 500),
    };
  }

  files.push({
    path: "filings/validation.json",
    bytes: utf8(JSON.stringify(__v, null, 2)),
  });
} catch (e: any) {
  files.push({
    path: "filings/validation.json",
    bytes: utf8(
      JSON.stringify(
        {
          ok: false,
          error: "validation embed failed",
          message: String(e?.message || e),
        },
        null,
        2
      )
    ),
  });
}
/*__VALIDATION_EMBED_V5_END__*/

"""

s = s[:insert_at] + block + s[insert_at:]

p.write_text(s)
print("✅ patched route.ts: clean validation embed inserted before hashes")
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
  tail -n 220 "$ROOT/.logs/next.log"
  exit 1
}

unzip -l "$TMP/packet.zip" | grep -q "filings/validation.json" || {
  echo "❌ filings/validation.json missing from zip"
  unzip -l "$TMP/packet.zip" | head -n 180
  exit 2
}

echo "✅ filings/validation.json present"
echo
echo "--- filings/validation.json (first 200 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,200p'
echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo "LOGS:"
echo "  tail -n 220 $ROOT/.logs/next.log"
