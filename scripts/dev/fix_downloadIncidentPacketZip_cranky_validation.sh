#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$ROOT/scripts/dev/_bak"
cp "$FILE" "$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

markers = [
  r"/\*__AUTO_MANIFEST_V1__\*/[\s\S]*?zip\.generateAsync\([^\)]*\);\s*",
  r"/\*__VALIDATION_EMBED_SAFE_START__\*/[\s\S]*?/\*__VALIDATION_EMBED_SAFE_END__\*/\s*",
]
for pat in markers:
  s = re.sub(pat, "", s, flags=re.M)

m = re.search(r"\n\s*const\s+hashes:\s*Record<string,\s*string>\s*=\s*\{\};", s)
if not m:
  raise SystemExit("❌ Could not find `const hashes: Record<string, string> = {};` in route.ts")

insert_at = m.start()

block = r'''
/*__VALIDATION_EMBED_SAFE_START__*/
// Build validation artifacts for DIRS + OE_417 from the generated filings/*.json docs.
// Output:
//   filings/validation.json
//   filings/dirs.validation.json
//   filings/oe417.validation.json

function _isObj(x: any) { return x && typeof x === "object" && !Array.isArray(x); }
function _req(obj: any, path: string) {
  const parts = path.split(".");
  let cur = obj;
  for (const k of parts) {
    if (!_isObj(cur) || !(k in cur)) return { ok: false, missing: path };
    cur = (cur as any)[k];
  }
  return { ok: true };
}

function validateDirsPayload(doc: any) {
  const out: any = { ok: true, schema: "dirs.v1", errors: [] as any[] };
  const payload = doc?.payload ?? null;
  if (!_isObj(payload)) out.errors.push({ code: "MISSING_PAYLOAD" });

  const checks = ["meta.schemaVersion","filingType","startTime","location.state","incidentId","orgId"];
  for (const c of checks) {
    const r = _req(payload, c);
    if (!r.ok) out.errors.push({ code: "MISSING_FIELD", field: c });
  }
  if (payload?.meta?.schemaVersion && payload.meta.schemaVersion !== "dirs.v1") {
    out.errors.push({ code: "BAD_SCHEMA", expected: "dirs.v1", got: payload.meta.schemaVersion });
  }
  if (payload?.filingType && String(payload.filingType).toUpperCase() !== "DIRS") {
    out.errors.push({ code: "BAD_FILING_TYPE", expected: "DIRS", got: payload.filingType });
  }
  out.ok = out.errors.length === 0;
  return out;
}

function validateOe417Payload(doc: any) {
  const out: any = { ok: true, schema: "oe_417.v1", errors: [] as any[] };
  const payload = doc?.payload ?? null;
  if (!_isObj(payload)) out.errors.push({ code: "MISSING_PAYLOAD" });

  const checks = ["meta.schemaVersion","filingType","startTime","eventType","impact","incidentId","orgId"];
  for (const c of checks) {
    const r = _req(payload, c);
    if (!r.ok) out.errors.push({ code: "MISSING_FIELD", field: c });
  }
  if (payload?.meta?.schemaVersion && payload.meta.schemaVersion !== "oe_417.v1") {
    out.errors.push({ code: "BAD_SCHEMA", expected: "oe_417.v1", got: payload.meta.schemaVersion });
  }
  if (payload?.filingType && String(payload.filingType).toUpperCase() !== "OE_417") {
    out.errors.push({ code: "BAD_FILING_TYPE", expected: "OE_417", got: payload.filingType });
  }
  out.ok = out.errors.length === 0;
  return out;
}

function _findFileBytes(path: string) {
  const f = files.find((x: any) => x?.path === path);
  return f?.bytes || null;
}
function _parseJsonBytes(bytes: any) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return null; }
}

const __dirsDoc = _parseJsonBytes(_findFileBytes("filings/dirs.json"));
const __oeDoc   = _parseJsonBytes(_findFileBytes("filings/oe417.json"));

const __dirsV = validateDirsPayload(__dirsDoc);
const __oeV   = validateOe417Payload(__oeDoc);

const __validation = {
  ok: Boolean(__dirsV.ok && __oeV.ok),
  generatedAt: nowIso,
  orgId,
  incidentId,
  summary: {
    dirsOk: __dirsV.ok,
    oe417Ok: __oeV.ok,
    errorCount: (__dirsV.errors?.length || 0) + (__oeV.errors?.length || 0),
  },
  dirs: __dirsV,
  oe417: __oeV,
};

files.push({ path: "filings/dirs.validation.json", bytes: utf8(JSON.stringify(__dirsV, null, 2)) });
files.push({ path: "filings/oe417.validation.json", bytes: utf8(JSON.stringify(__oeV, null, 2)) });
files.push({ path: "filings/validation.json", bytes: utf8(JSON.stringify(__validation, null, 2)) });
/*__VALIDATION_EMBED_SAFE_END__*/

'''

s2 = s[:insert_at] + block + s[insert_at:]
p.write_text(s2)
print("✅ patched route.ts: inserted SAFE validation embed before hashes")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet and verify validation files exist"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_validation_fix_${TS}"
mkdir -p "$TMP"

curl -fsS "$DURL" -o "$TMP/packet.zip" || {
  echo "❌ download failed"
  tail -n 220 "$ROOT/.logs/next.log"
  exit 1
}

unzip -l "$TMP/packet.zip" | grep -E "filings/(validation\.json|dirs\.validation\.json|oe417\.validation\.json)" >/dev/null || {
  echo "❌ validation files missing from zip"
  unzip -l "$TMP/packet.zip" | head -n 220
  exit 2
}

echo "✅ validation files present in packet.zip"
echo
echo "--- filings/validation.json (first 120 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,120p'
echo
echo "✅ DONE"
