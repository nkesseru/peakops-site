#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
[[ -d "$ROOT/next-app" ]] || { echo "❌ run from repo root (folder containing next-app/)"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"

ROUTE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
VLIB_DIR="$ROOT/next-app/src/app/api/_lib"
VAL_PANEL="$ROOT/next-app/src/app/admin/_components/ValidationPanel.tsx"

echo "==> (0) backups"
cp "$ROUTE" "$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
[[ -f "$VAL_PANEL" ]] && cp "$VAL_PANEL" "$ROOT/scripts/dev/_bak/ValidationPanel_${TS}.tsx" || true

echo "==> (1) ensure validator libs exist (dirs + oe417)"
mkdir -p "$VLIB_DIR"

# create validateDirsV1.ts if missing
if [[ ! -f "$VLIB_DIR/validateDirsV1.ts" ]]; then
cat > "$VLIB_DIR/validateDirsV1.ts" <<'TS'
export function validateDirsV1(payload: any): string[] {
  const e: string[] = [];
  const p = payload || {};
  const filingType = String(p.filingType || p.type || "").toUpperCase();
  if (filingType !== "DIRS") e.push("filingType must be 'DIRS'");
  if (typeof p.incidentId !== "string" || !p.incidentId) e.push("incidentId required (string)");
  if (typeof p.orgId !== "string" || !p.orgId) e.push("orgId required (string)");
  if (typeof p.startTime !== "string" || p.startTime.length < 10) e.push("startTime required (ISO string)");

  const outageType = String(p.outageType || "").toUpperCase();
  if (!["WIRELINE","WIRELESS","BROADBAND","OTHER"].includes(outageType)) {
    e.push("outageType required (WIRELINE/WIRELESS/BROADBAND/OTHER)");
  }
  const narrative = String(p.narrative || "");
  if (narrative.trim().length < 10) e.push("narrative required (>=10 chars)");

  const affectedCount = p.affectedCount;
  if (typeof affectedCount !== "number" || affectedCount < 0) e.push("affectedCount required (number >=0)");

  if (typeof p.location !== "object" || !p.location) e.push("location required (object)");
  return e;
}
TS
fi

# create validateOe417V1.ts if missing
if [[ ! -f "$VLIB_DIR/validateOe417V1.ts" ]]; then
cat > "$VLIB_DIR/validateOe417V1.ts" <<'TS'
export function validateOe417V1(payload: any): string[] {
  const e: string[] = [];
  const p = payload || {};
  const filingType = String(p.filingType || p.type || "").toUpperCase();
  if (filingType !== "OE_417") e.push("filingType must be 'OE_417'");
  if (typeof p.incidentId !== "string" || !p.incidentId) e.push("incidentId required (string)");
  if (typeof p.orgId !== "string" || !p.orgId) e.push("orgId required (string)");
  if (typeof p.startTime !== "string" || p.startTime.length < 10) e.push("startTime required (ISO string)");

  const eventType = String(p.eventType || "");
  if (!eventType) e.push("eventType required (string)");

  const impact = String(p.impact || "").toUpperCase();
  if (!["PARTIAL_SERVICE","TOTAL_OUTAGE","DEGRADED","OTHER"].includes(impact)) {
    e.push("impact required (PARTIAL_SERVICE/TOTAL_OUTAGE/DEGRADED/OTHER)");
  }
  const narrative = String(p.narrative || "");
  if (narrative.trim().length < 10) e.push("narrative required (>=10 chars)");
  return e;
}
TS
fi

echo "==> (2) patch downloadIncidentPacketZip to write filings/validation*.json into packet"
python3 - <<'PY'
from pathlib import Path
import re, json

route = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = route.read_text()

# Ensure imports exist and are not pointing into functions_clean
# Remove any bad imports that reference functions_clean validators
s = re.sub(r'^\s*import\s+\{\s*validateDirsV1\s*\}\s+from\s+["\'].*functions_clean.*["\'];\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+\{\s*validateOe417V1\s*\}\s+from\s+["\'].*functions_clean.*["\'];\s*\n', '', s, flags=re.M)

# Ensure correct imports from api/_lib
if "validateDirsV1" not in s:
    # insert after JSZip import if possible, else after NextResponse import
    m = re.search(r'^(import\s+JSZip\s+from\s+["\']jszip["\'];\s*)\n', s, flags=re.M)
    if m:
        ins_at = m.end()
    else:
        m2 = re.search(r'^(import\s+\{\s*NextResponse\s*\}\s+from\s+["\']next/server["\'];\s*)\n', s, flags=re.M)
        ins_at = m2.end() if m2 else 0
    s = s[:ins_at] + 'import { validateDirsV1 } from "../../_lib/validateDirsV1";\n' + s[ins_at:]

if "validateOe417V1" not in s:
    # place near dirs import
    if 'import { validateDirsV1 }' in s and 'import { validateOe417V1 }' not in s:
        s = s.replace('import { validateDirsV1 } from "../../_lib/validateDirsV1";\n',
                      'import { validateDirsV1 } from "../../_lib/validateDirsV1";\nimport { validateOe417V1 } from "../../_lib/validateOe417V1";\n')

# Remove the old broken AUTO_MANIFEST block if present (it can break compilation)
s = re.sub(r'/\*__AUTO_MANIFEST_V1__\*/[\s\S]*?zip\.generateAsync\([^\)]*\);\s*', '', s, flags=re.M)

# Insert validation writer block exactly once, anchored AFTER filings are created but BEFORE hashes/manifest are computed.
if "/*__WRITE_VALIDATION_V1__*/" not in s:
    anchor = re.search(r'^\s*//\s*hashes\s*\+\s*manifest.*$', s, flags=re.M)
    if not anchor:
        # alternate anchor: first occurrence where hashes object is created
        anchor = re.search(r'^\s*const\s+hashes\s*:\s*Record<\s*string\s*,\s*string\s*>\s*=\s*\{\s*\}\s*;\s*$', s, flags=re.M)
    if not anchor:
        raise SystemExit("❌ Could not find anchor for inserting validation block. Look for '// hashes + manifest' or 'const hashes: Record...'")

    insert_at = anchor.start()

    block = r'''
    /*__WRITE_VALIDATION_V1__*/
    // Build validation from filings payloads and embed into packet under filings/validation*.json
    try {
      const getFileJson = (path: string): any | null => {
        const f = files.find((x: any) => x?.path === path);
        if (!f) return null;
        try { return JSON.parse(Buffer.from(f.bytes).toString("utf8")); } catch { return null; }
      };

      const dirsDoc = getFileJson("filings/dirs.json");
      const oeDoc = getFileJson("filings/oe417.json");

      const dirsPayload = (dirsDoc && (dirsDoc.payload ?? dirsDoc)) || null;
      const oePayload   = (oeDoc && (oeDoc.payload ?? oeDoc)) || null;

      const dirsErrs = validateDirsV1(dirsPayload);
      const oeErrs   = validateOe417V1(oePayload);

      const validation = {
        ok: dirsErrs.length === 0 && oeErrs.length === 0,
        orgId,
        incidentId,
        generatedAt: nowIso,
        results: {
          DIRS:   { valid: dirsErrs.length === 0, errors: dirsErrs },
          OE_417: { valid: oeErrs.length === 0, errors: oeErrs },
        },
      };

      files.push({ path: "filings/validation.json", bytes: utf8(JSON.stringify(validation, null, 2)) });
      files.push({ path: "filings/dirs.validation.json", bytes: utf8(JSON.stringify({ ok: dirsErrs.length===0, errors: dirsErrs, generatedAt: nowIso }, null, 2)) });
      files.push({ path: "filings/oe417.validation.json", bytes: utf8(JSON.stringify({ ok: oeErrs.length===0, errors: oeErrs, generatedAt: nowIso }, null, 2)) });
    } catch (e: any) {
      // never fail packet generation because of validation
      files.push({
        path: "filings/validation_error.json",
        bytes: utf8(JSON.stringify({ ok: false, generatedAt: nowIso, error: String(e?.message || e) }, null, 2)),
      });
    }
'''
    s = s[:insert_at] + block + "\n" + s[insert_at:]

route.write_text(s)
print("✅ downloadIncidentPacketZip patched to write filings/validation.json (+ per-filing validation files)")
PY

echo "==> (3) UI: add color badges + simple layout to ValidationPanel (safe edit)"
if [[ -f "$VAL_PANEL" ]]; then
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/ValidationPanel.tsx")
s = p.read_text()

# If already has "badge" helper, do nothing
if "function badge" not in s:
    # Insert a small badge helper after imports
    m = re.search(r'(^import[\s\S]*?\n)\n', s, flags=re.M)
    ins_at = m.end() if m else 0
    badge = r'''
function badge(ok: boolean): React.CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 900,
    border: "1px solid " + (ok ? "color-mix(in oklab, lime 45%, transparent)" : "color-mix(in oklab, crimson 45%, transparent)"),
    background: ok ? "color-mix(in oklab, lime 18%, transparent)" : "color-mix(in oklab, crimson 18%, transparent)",
    color: "CanvasText",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };
}
'''
    s = s[:ins_at] + badge + s[ins_at:]

# Replace render of each result with colored summary if we can find a simple map
# We'll just leave file mostly intact and add a small block if not present.
if "Schema Validation" not in s:
    # it's fine; panel is already embedded in incident page with PanelCard title
    pass

# Ensure it prints a compact header line with overall ok
if "Overall" not in s:
    # try to inject into JSX after first <div> return wrapper
    s = s.replace(
        "return (",
        "return (\n    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>\n      <span style={badge(!!data?.ok)}>{data?.ok ? 'PASS' : 'FAIL'}</span>\n      <span style={{ fontSize: 12, opacity: 0.8 }}>DIRS: {data?.results?.DIRS?.valid ? '✅' : '❌'} · OE-417: {data?.results?.OE_417?.valid ? '✅' : '❌'}</span>\n    </div>\n"
    )

p.write_text(s)
print("✅ ValidationPanel: added PASS/FAIL badge + compact header")
PY
else
  echo "⚠️ ValidationPanel.tsx not found (skipping UI badge patch)"
fi

echo "==> (4) restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > "../.logs/next.log" 2>&1 ) &
sleep 2

echo "==> (5) smoke: download packet zip + verify validation files exist"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_packet_validation_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/p.zip" || { echo "❌ download failed"; tail -n 120 "$LOGDIR/next.log"; exit 1; }

echo "==> zip contains:"
unzip -l "$TMP/p.zip" | egrep "filings/(validation\.json|dirs\.validation\.json|oe417\.validation\.json)" || {
  echo "❌ validation files missing from zip"
  unzip -l "$TMP/p.zip" | head -n 120
  exit 2
}

echo
echo "==> preview filings/validation.json"
unzip -p "$TMP/p.zip" filings/validation.json | sed -n '1,200p'

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
