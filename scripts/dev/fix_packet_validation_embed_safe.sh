#!/usr/bin/env bash
set +H 2>/dev/null || true
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
if [[ ! -f "$FILE" ]]; then
  echo "❌ route.ts not found: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$ROOT/scripts/dev/_bak"
cp "$FILE" "$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# --- 1) Remove any previous/broken validation blocks if present ---
# Remove marker blocks (any version)
s = re.sub(r"/\*__VALIDATION_EMBED_[A-Z0-9_]+_START__\*/[\s\S]*?/\*__VALIDATION_EMBED_[A-Z0-9_]+_END__\*/\s*", "", s)

# Remove the specific broken url fragments that look like: const __vUrl =  + ;
s = re.sub(r"^\s*const\s+__vUrl\s*=\s*(?:.|\n)*?^\s*;\s*$", "", s, flags=re.M)
s = re.sub(r"^\s*const\s+vUrl\s*=\s*(?:.|\n)*?^\s*;\s*$", "", s, flags=re.M)

# Remove dangling fragment lines that were left behind (common failure signature)
s = re.sub(r"^\s*,\s*null\s*,\s*2\)\)\s*$", "", s, flags=re.M)

# --- 2) Insert SAFE local validation helpers + embed output before hashes ---
anchor = re.search(r"^\s*//\s*hashes\s*\+\s*manifest.*$", s, flags=re.M)
if not anchor:
    raise SystemExit("❌ Could not find anchor comment: // hashes + manifest")

insert_at = anchor.start()

block = r'''
/*__VALIDATION_EMBED_SAFE_START__*/
// --- Schema validation (embedded into packet) ---
// No network calls. We validate the payloads we already placed into files[].
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
    cur = cur[k];
  }
  return { ok: true };
}

function validateDirsPayload(doc: any) {
  const out: any = { ok: true, schema: "dirs.v1", errors: [] as any[] };
  if (!_isObj(doc)) return { ok: false, schema: "dirs.v1", errors: [{ code: "NOT_OBJECT" }] };

  // doc wrapper expectations
  const payload = doc.payload ?? null;
  if (!_isObj(payload)) out.errors.push({ code: "MISSING_PAYLOAD" });

  // core fields (minimal, stable)
  const checks = [
    "meta.schemaVersion",
    "filingType",
    "startTime",
    "location.state",
    "incidentId",
    "orgId",
  ];
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
  if (!_isObj(doc)) return { ok: false, schema: "oe_417.v1", errors: [{ code: "NOT_OBJECT" }] };

  const payload = doc.payload ?? null;
  if (!_isObj(payload)) out.errors.push({ code: "MISSING_PAYLOAD" });

  const checks = [
    "meta.schemaVersion",
    "filingType",
    "startTime",
    "eventType",
    "impact",
    "incidentId",
    "orgId",
  ];
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

// locate the filings docs we already added into files[]
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

// embed into packet
files.push({ path: "filings/dirs.validation.json", bytes: utf8(JSON.stringify(__dirsV, null, 2)) });
files.push({ path: "filings/oe417.validation.json", bytes: utf8(JSON.stringify(__oeV, null, 2)) });
files.push({ path: "filings/validation.json", bytes: utf8(JSON.stringify(__validation, null, 2)) });
/*__VALIDATION_EMBED_SAFE_END__*/

'''
s = s[:insert_at] + block + s[insert_at:]
p.write_text(s)
print("✅ patched route.ts: replaced broken validation with SAFE local embed")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet and ensure validation files exist"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_validation_smoke_${TS}"
mkdir -p "$TMP"

curl -fsS "$DURL" -o "$TMP/packet.zip" || {
  echo "❌ download failed"
  tail -n 220 "$ROOT/.logs/next.log"
  exit 1
}

unzip -l "$TMP/packet.zip" | grep -E "filings/(validation\.json|dirs\.validation\.json|oe417\.validation\.json)" >/dev/null || {
  echo "❌ validation files missing from zip"
  unzip -l "$TMP/packet.zip" | head -n 200
  exit 2
}

echo "✅ validation files present in packet.zip"
echo
echo "--- filings/validation.json (first 120 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,120p'

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo "LOGS:"
echo "  tail -n 220 $ROOT/.logs/next.log"
