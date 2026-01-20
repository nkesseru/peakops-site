#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ Missing: $FILE"
  echo "Searching for downloadIncidentPacketZip route..."
  find next-app/src/app/api -maxdepth 6 -type f -name "route.ts" | rg "downloadIncidentPacketZip" || true
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# 1) Ensure we have an incident filings fetch block
if "__REAL_INCIDENT_FILINGS_V1__" not in s:
  # We insert after orgId/incidentId are resolved.
  # Try a few anchors in order.
  anchors = [
    r'const\s+incidentId\s*=\s*[^;]+;\s*',
    r'const\s+orgId\s*=\s*[^;]+;\s*',
  ]
  insert_at = None
  for a in anchors:
    m = re.search(a, s)
    if m:
      insert_at = m.end()
  if insert_at is None:
    raise SystemExit("❌ Could not find orgId/incidentId declarations to anchor insertion. Open the file and search for `incidentId` and `orgId`.")

  block = r'''
/*__REAL_INCIDENT_FILINGS_V1__*/
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
  s = s[:insert_at] + "\n" + block + "\n" + s[insert_at:]

# 2) Find where the route builds filings files and patch payload assignment for DIRS + OE_417.
# We look for the filings descriptor array that contains these exact entries.
if 'filings/dirs.json' not in s or 'filings/oe417.json' not in s:
  raise SystemExit('❌ route.ts does not contain filings/dirs.json and filings/oe417.json entries. Run: rg -n "filings/dirs\\.json|filings/oe417\\.json" next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts')

# We want to ensure a map exists in-scope before files are pushed.
# Insert right before the loop that processes filings entries (heuristic: a `for (const f of` near those entries).
loop_anchor = re.search(r'for\s*\(\s*const\s+\w+\s+of\s+[^)]+\)\s*\{', s)
if not loop_anchor:
  # alternative: "for (const spec of FILINGS)"
  loop_anchor = re.search(r'for\s*\(\s*const\s+\w+\s+of\s+\w+\s*\)\s*\{', s)
if not loop_anchor:
  raise SystemExit("❌ Could not find filings loop to patch (no `for (const ... of ...) {`).")

# Only insert the filings lookup once.
if "__REAL_FILINGS_LOOKUP_V1__" not in s:
  inject = r'''
/*__REAL_FILINGS_LOOKUP_V1__*/
const __filingsByType = await fetchIncidentFilings(orgId, incidentId);
'''
  s = s[:loop_anchor.start()] + inject + "\n" + s[loop_anchor.start():]

# Now patch the specific writer for dirs/oe417.
# Common pattern: JSON.stringify({ type: spec.type, schemaVersion: spec.schema, payload: { _placeholder:"INIT" } ... })
# We'll replace ONLY the payload expression to prefer real filing.payload when present.
def patch_payload_for(type_name: str):
  nonlocal s
  # Match within the JSON stringify object where type is "DIRS" / "OE_417"
  # Replace payload: { ... } with payload: (__filingsByType["DIRS"]?.payload || { _placeholder:"INIT" })
  pat = re.compile(rf'(type\s*:\s*"{re.escape(type_name)}"[\s\S]*?payload\s*:\s*)(\{{[\s\S]*?\}})', re.M)
  m = pat.search(s)
  if not m:
    return False
  repl_payload = f'\\1(__filingsByType["{type_name}"]?.payload || {{ "_placeholder":"INIT" }})'
  s = pat.sub(repl_payload, s, count=1)
  return True

ok1 = patch_payload_for("DIRS")
ok2 = patch_payload_for("OE_417")

if not ok1:
  raise SystemExit('❌ Could not patch DIRS payload assignment. In route.ts, search for the object that writes DIRS and confirm it has `type: "DIRS"` and a `payload:` field.')
if not ok2:
  raise SystemExit('❌ Could not patch OE_417 payload assignment. In route.ts, search for the object that writes OE_417 and confirm it has `type: "OE_417"` and a `payload:` field.')

p.write_text(s)
print("✅ patched route.ts: DIRS + OE_417 now prefer incident_filings payloads")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: generateFilingsV1 then download packet"
BASE="http://127.0.0.1:3000"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" >/dev/null || true

TMP="/tmp/packet_dirs_oe417_${TS}"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123" -o "$TMP/p.zip"

echo "-- filings/dirs.json (first 600 chars) --"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 600; echo
echo
echo "-- filings/oe417.json (first 600 chars) --"
unzip -p "$TMP/p.zip" "filings/oe417.json" | head -c 600; echo

echo
echo "✅ done. If those payloads are not INIT anymore, DIRS/OE_417 are wired."
