#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

# find repo root (has next-app/)
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
  echo "❌ Missing: $FILE"
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

# --- 1) remove any prior validation blocks by markers (safe) ---
marker_blocks = [
  (r"/\*__VALIDATION_EMBED_SAFE_START__\*/", r"/\*__VALIDATION_EMBED_SAFE_END__\*/"),
  (r"/\*__VALIDATION_EMBED_START__\*/", r"/\*__VALIDATION_EMBED_END__\*/"),
]
for a,b in marker_blocks:
  s = re.sub(a + r"[\s\S]*?" + b, "", s, flags=re.M)

# --- 2) remove the known broken injected URL chunks that cause "Expression expected" ---
# pattern: const __vUrl = \n  + \n  ;
s = re.sub(r"\bconst\s+__vUrl\s*=\s*\n\s*\+\s*\n\s*;\s*\n", "", s, flags=re.M)
s = re.sub(r"\bconst\s+vUrl\s*=\s*\n\s*\+\s*\n\s*;\s*\n", "", s, flags=re.M)

# also remove any orphan fetch lines that referenced these vars (best-effort)
s = re.sub(r"^\s*const\s+__vRes\s*=\s*await\s+fetch\(__vUrl[^\n]*\)\s*;\s*$", "", s, flags=re.M)
s = re.sub(r"^\s*const\s+__vTxt\s*=\s*await\s+__vRes\.text\(\)\s*;\s*$", "", s, flags=re.M)
s = re.sub(r"^\s*const\s+vRes\s*=\s*await\s+fetch\(vUrl[^\n]*\)\s*;\s*$", "", s, flags=re.M)
s = re.sub(r"^\s*const\s+vTxt\s*=\s*await\s+vRes\.text\(\)\s*;\s*$", "", s, flags=re.M)

# --- 3) insert SAFE validation helper block right before hashes/manifest section ---
anchor = re.search(r"^\s*// hashes \+ manifest", s, flags=re.M)
if not anchor:
  raise SystemExit("❌ Could not find anchor line: // hashes + manifest")

validation_block = """
/*__VALIDATION_EMBED_SAFE_START__*/
// ---- Schema validation (SAFE, local only) ----
// No imports, no fetch, no cross-module dependencies.
// We validate basic presence/shape so UI can colorize and we can evolve schemas later.

type ValidationOut = {
  ok: boolean;
  schema: string;
  filingType: string;
  errors: string[];
  warnings: string[];
  checkedAt: string;
};

function validateFilingDoc(doc: any, schema: string, filingType: string): ValidationOut {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checkedAt = new Date().toISOString();

  if (!doc || typeof doc !== "object") errors.push("doc missing or not an object");

  const payload = doc?.payload ?? doc?.payloadJson ?? doc?.data ?? null;
  if (!payload || typeof payload !== "object") errors.push("payload missing or not an object");

  const st = String(doc?.status || payload?.status || "").toUpperCase();
  if (!st) warnings.push("status missing");

  const org = doc?.orgId ?? payload?.orgId;
  const inc = doc?.incidentId ?? payload?.incidentId;
  if (!org) warnings.push("orgId missing");
  if (!inc) warnings.push("incidentId missing");

  if (filingType === "DIRS") {
    if (!payload?.startTime) warnings.push("DIRS.startTime missing");
    if (!payload?.outageType) warnings.push("DIRS.outageType missing");
  }
  if (filingType === "OE_417") {
    if (!payload?.eventType) warnings.push("OE_417.eventType missing");
    if (!payload?.startTime) warnings.push("OE_417.startTime missing");
  }

  return { ok: errors.length === 0, schema, filingType, errors, warnings, checkedAt };
}

// captured docs (set later if we can)
let __dirsDoc: any = null;
let __oeDoc: any = null;
/*__VALIDATION_EMBED_SAFE_END__*/
"""

s = s[:anchor.start()] + validation_block + "\n\n" + s[anchor.start():]

# --- 4) try to capture the docs when building filings (best effort) ---
# We look for the "wanted" loop pattern and insert capture right after doc computed.
capture_snippet = """
      if (w.type === "DIRS") __dirsDoc = doc;
      if (w.type === "OE_417") __oeDoc = doc;
"""

# insert after "const doc = found ? { ... } : { ... };" block end (first occurrence)
s2, n = re.subn(r"(const\s+doc\s*=\s*found[\s\S]*?\n\s*};\s*\n)", r"\\1"+capture_snippet+"\n", s, count=1)
s = s2

# --- 5) emit validation files BEFORE hashes.json computation ---
# Insert immediately before the hashes section (same anchor as before; now later in file)
anchor2 = re.search(r"^\s*// hashes \+ manifest", s, flags=re.M)
if not anchor2:
  raise SystemExit("❌ Could not find anchor line after insertion")

emit_block = """
    // ---- emit validation artifacts into packet ----
    const __dirsV = validateFilingDoc(__dirsDoc, "dirs.v1", "DIRS");
    const __oeV   = validateFilingDoc(__oeDoc, "oe_417.v1", "OE_417");
    const __validation = {
      ok: __dirsV.ok && __oeV.ok,
      generatedAt: nowIso,
      orgId,
      incidentId,
      summary: {
        errorCount: (__dirsV.errors.length + __oeV.errors.length),
        warningCount: (__dirsV.warnings.length + __oeV.warnings.length),
      },
      dirs: __dirsV,
      oe417: __oeV,
    };

    files.push({ path: "filings/dirs.validation.json", bytes: utf8(JSON.stringify(__dirsV, null, 2)) });
    files.push({ path: "filings/oe417.validation.json", bytes: utf8(JSON.stringify(__oeV, null, 2)) });
    files.push({ path: "filings/validation.json", bytes: utf8(JSON.stringify(__validation, null, 2)) });

"""

s = s[:anchor2.start()] + emit_block + "\n" + s[anchor2.start():]

p.write_text(s)
print("✅ patched route.ts: removed broken url blocks + added SAFE validation embed + emits validation jsons")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet + verify validation files exist"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_validation_megabash_${TS}"
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
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,120p' || true
echo
echo "✅ DONE"
