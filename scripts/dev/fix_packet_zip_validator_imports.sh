#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

ROUTE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
LIBDIR="next-app/src/app/api/fn/_lib"

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$ROUTE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

echo "==> (1) ensure _lib exists"
mkdir -p "$LIBDIR"

echo "==> (2) write validateDirsV1.ts"
cat > "$LIBDIR/validateDirsV1.ts" <<'TS'
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isObj(v: any) { return v && typeof v === "object" && !Array.isArray(v); }

export function validateDirsV1(payload: any): ValidationResult {
  const errors: string[] = [];
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };

  const reqStr = (path: string, v: any) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${path} must be a non-empty string`);
  };
  const reqNum = (path: string, v: any) => {
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${path} must be a number`);
  };

  reqStr("filingType", payload.filingType);
  if (payload.filingType && String(payload.filingType).toUpperCase() !== "DIRS") {
    errors.push(`filingType must be "DIRS"`);
  }

  reqStr("outageType", payload.outageType);
  reqStr("startTime", payload.startTime);
  reqStr("narrative", payload.narrative);
  reqNum("affectedCount", payload.affectedCount);

  if (!isObj(payload.location)) {
    errors.push("location must be an object");
  } else {
    reqStr("location.state", payload.location.state);
    reqStr("location.county", payload.location.county);
  }

  // optional but useful
  if (payload.orgId != null) reqStr("orgId", payload.orgId);
  if (payload.incidentId != null) reqStr("incidentId", payload.incidentId);

  return errors.length ? { ok: false, errors } : { ok: true };
}
TS

echo "==> (3) write validateOe417V1.ts"
cat > "$LIBDIR/validateOe417V1.ts" <<'TS'
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isObj(v: any) { return v && typeof v === "object" && !Array.isArray(v); }

export function validateOe417V1(payload: any): ValidationResult {
  const errors: string[] = [];
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };

  const reqStr = (path: string, v: any) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${path} must be a non-empty string`);
  };

  reqStr("filingType", payload.filingType);
  const ft = payload.filingType ? String(payload.filingType).toUpperCase() : "";
  if (ft !== "OE_417" && ft !== "OE-417") errors.push(`filingType must be "OE_417" (or "OE-417")`);

  reqStr("eventType", payload.eventType);
  reqStr("impact", payload.impact);
  reqStr("startTime", payload.startTime);
  reqStr("narrative", payload.narrative);

  // optional but useful
  if (payload.orgId != null) reqStr("orgId", payload.orgId);
  if (payload.incidentId != null) reqStr("incidentId", payload.incidentId);

  return errors.length ? { ok: false, errors } : { ok: true };
}
TS

echo "==> (4) patch route.ts imports (remove functions_clean imports, add _lib imports)"
python3 - <<'PY'
from pathlib import Path
import re

route = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = route.read_text()

# Remove any imports that try to pull validators from functions_clean (or weird deep paths)
s = re.sub(r'^\s*import\s+\{\s*validateDirsV1\s*\}\s+from\s+["\'][^"\']*functions_clean[^"\']*["\']\s*;\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+\{\s*validateOe417V1\s*\}\s+from\s+["\'][^"\']*functions_clean[^"\']*["\']\s*;\s*\n', '', s, flags=re.M)

# Also handle older name validateOe417V1 / validateOe417V1 with oe417 casing variants
s = re.sub(r'^\s*import\s+\{\s*validateOe417V1\s*\}\s+from\s+["\'][^"\']*["\']\s*;\s*\n', lambda m: m.group(0) if 'functions_clean' not in m.group(0) else '', s, flags=re.M)

# Ensure we have our new imports near the top
lines = s.splitlines(True)

def has(line_sub):
    return any(line_sub in ln for ln in lines)

insert_after = None
for i, ln in enumerate(lines):
    if "from \"next/server\"" in ln or "from 'next/server'" in ln:
        insert_after = i
        break

if insert_after is None:
    # fallback: after first import
    for i, ln in enumerate(lines):
        if ln.strip().startswith("import "):
            insert_after = i
            break

imports = ""
if not has("validateDirsV1") or not has("../_lib/validateDirsV1"):
    imports += 'import { validateDirsV1 } from "../_lib/validateDirsV1";\n'
if not has("validateOe417V1") or not has("../_lib/validateOe417V1"):
    imports += 'import { validateOe417V1 } from "../_lib/validateOe417V1";\n'

if imports:
    lines.insert(insert_after + 1, imports)

route.write_text(''.join(lines))
print("✅ route.ts imports patched")
PY

echo "==> (5) restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (6) smoke: download packet zip (should be 200)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$DURL" | head -n 25 || { echo "❌ still failing"; tail -n 180 .logs/next.log; exit 1; }

echo
echo "==> (7) smoke: confirm validation files exist (if your route writes them)"
TMP="/tmp/packet_validator_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/p.zip"
unzip -l "$TMP/p.zip" | egrep "filings/(dirs|oe417)\.validation\.json" || true

echo
echo "✅ DONE (route compiles again)"
echo "If zip list above is empty, it just means the route isn't writing validation files yet—but the build error is fixed."
