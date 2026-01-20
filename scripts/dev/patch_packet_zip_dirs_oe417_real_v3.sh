#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
[[ -f "$FILE" ]] || { echo "❌ Missing: $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# --- (A) Ensure we have a helper to fetch incident filings (via getIncidentBundleV1) ---
if "__REAL_INCIDENT_FILINGS_V2__" not in s:
    insert_anchor = re.search(r'(const\s+orgId\s*=.*?;\s*[\r\n]+.*?const\s+incidentId\s*=.*?;\s*)', s, re.S)
    if not insert_anchor:
        # fallback: just after incidentId assignment if separate
        insert_anchor = re.search(r'(const\s+incidentId\s*=.*?;\s*)', s, re.S)
    if not insert_anchor:
        raise SystemExit("❌ Could not find orgId/incidentId declarations in route.ts")

    helper = r'''
/*__REAL_INCIDENT_FILINGS_V2__*/
async function fetchIncidentFilings(orgId: string, incidentId: string): Promise<Record<string, any>> {
  try {
    const base =
      (process.env.FN_BASE || process.env.NEXT_PUBLIC_FN_BASE || "").trim() ||
      "http://127.0.0.1:5001/peakops-pilot/us-central1";

    const url = `${base}/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    const r = await fetch(url, { method: "GET" });
    const j = await r.json().catch(() => null);

    const filings = Array.isArray(j?.filings) ? j.filings : [];
    const out: Record<string, any> = {};
    for (const f of filings) {
      const t = String(f?.type || f?.id || "").toUpperCase();
      if (!t) continue;
      out[t] = f;
    }
    return out;
  } catch {
    return {};
  }
}
'''
    s = s[:insert_anchor.end()] + "\n" + helper + "\n" + s[insert_anchor.end():]

# --- (B) Find the filings spec array (contains `filings/dirs.json` and `filings/oe417.json`) ---
if 'filings/dirs.json' not in s or 'filings/oe417.json' not in s:
    raise SystemExit('❌ Expected specs for filings/dirs.json and filings/oe417.json not found in route.ts')

# --- (C) Ensure we compute a lookup map once before the loop that writes filings files ---
if "__FILINGS_BY_TYPE_V2__" not in s:
    # Find the first occurrence of the spec array (we'll insert right AFTER it ends, before the writer loop)
    # Heuristic: locate the block that starts with `const FILINGS = [` or similar and ends with `];`
    m = re.search(r'(const\s+\w+\s*=\s*\[\s*[\s\S]*?filings/dirs\.json[\s\S]*?filings/oe417\.json[\s\S]*?\]\s*;)', s)
    if not m:
        raise SystemExit("❌ Could not locate the filings spec array block to anchor insertion.")

    inject = r'''
/*__FILINGS_BY_TYPE_V2__*/
const __filingsByType = await fetchIncidentFilings(orgId, incidentId);
'''
    s = s[:m.end()] + "\n" + inject + "\n" + s[m.end():]

# --- (D) Patch the writer so DIRS/OE_417 JSON uses incident filings payload when available ---
# We’ll patch the JSON object that is stringified for each filing spec.
# Common patterns:
#   payload: { "_placeholder":"INIT" }
#   payload: { _placeholder: "INIT" }
# We replace ONLY when the spec.type is DIRS or OE_417.

def patch_payload_block(type_name: str):
    # Find a nearby object-literal for this type with `type: "DIRS"` and `payload: ...`
    pat = re.compile(rf'(type\s*:\s*"{re.escape(type_name)}"[\s\S]*?payload\s*:\s*)(\{{[\s\S]*?\}})', re.M)
    m = pat.search(s)
    if not m:
        return s, False
    replacement = rf'\1(__filingsByType["{type_name}"]?.payload || {{ "_placeholder":"INIT" }})'
    return pat.sub(replacement, s, count=1), True

s2, ok_dirs = patch_payload_block("DIRS")
s3, ok_oe = patch_payload_block("OE_417")

if not ok_dirs or not ok_oe:
    # If it wasn’t written as `type:"DIRS"` objects, it may be written as `spec.type` loop.
    # Patch the generic loop form instead:
    #   payload: { "_placeholder":"INIT" }
    # -> payload: (__filingsByType[String(spec.type).toUpperCase()]?.payload || { "_placeholder":"INIT" })
    loop_pat = re.compile(r'payload\s*:\s*\{\s*["_a-zA-Z0-9]+\s*:\s*["\']INIT["\']\s*\}', re.M)
    if loop_pat.search(s):
        s = loop_pat.sub('payload: (__filingsByType[String(spec.type || spec.id).toUpperCase()]?.payload || { "_placeholder":"INIT" })', s, count=1)
        ok_dirs = ok_oe = True
        s3 = s
    else:
        raise SystemExit("❌ Could not patch payload writer. The writer shape didn’t match known patterns.")

# choose best patched string
s = s3

p.write_text(s)
print("✅ patched route.ts: DIRS + OE_417 now prefer incident filings payloads")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
BASE="http://127.0.0.1:3000"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" >/dev/null || true

TMP="/tmp/packet_dirs_oe417_${TS}"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123" -o "$TMP/p.zip"

echo
echo "-- filings/dirs.json (first 400 chars) --"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 400; echo
echo
echo "-- filings/oe417.json (first 400 chars) --"
unzip -p "$TMP/p.zip" "filings/oe417.json" | head -c 400; echo
echo
echo "✅ If those are NOT just _placeholder INIT, you're wired."
