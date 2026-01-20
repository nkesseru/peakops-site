#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"

if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# 1) Add imports if missing
if 'import { getFirestore' not in s:
  # Insert right after NextResponse import (or at top)
  if "from \"next/server\"" in s:
    s = re.sub(r'(from\s+"next/server";\s*\n)', r'\1import { initializeApp, getApps } from "firebase-admin/app";\nimport { getFirestore } from "firebase-admin/firestore";\n', s, count=1)
  else:
    s = 'import { initializeApp, getApps } from "firebase-admin/app";\nimport { getFirestore } from "firebase-admin/firestore";\n' + s

# 2) Ensure admin initialized
if "if (!getApps().length) initializeApp();" not in s:
  # place near top-level helpers
  insert_at = s.find("export async function GET")
  if insert_at == -1:
    raise SystemExit("❌ couldn't find export async function GET")
  s = s[:insert_at] + 'if (!getApps().length) initializeApp();\nconst __db = getFirestore();\n\n' + s[insert_at:]

# 3) Inject helper function (only once)
if "__readIncidentFiling" not in s:
  s = s.replace(
    "export async function GET(req: Request) {",
    """export async function GET(req: Request) {
  async function __readIncidentFiling(orgId: string, incidentId: string, type: string) {
    // we store filings under incident_filings with doc ids like: ${incidentId}_dirs_v1
    // fallback: scan by (orgId, incidentId, type)
    try {
      const qs = await __db.collection("incident_filings")
        .where("orgId","==",orgId)
        .where("incidentId","==",incidentId)
        .where("type","==",type)
        .orderBy("generatedAt","desc")
        .limit(1)
        .get();
      if (qs.empty) return null;
      const d = qs.docs[0];
      return { id: d.id, ...(d.data() as any) };
    } catch {
      return null;
    }
  }
""",
    1
  )

# 4) Replace the stub pushes for dirs/oe417 with "real if exists"
# We’ll match the push blocks by their path strings.
def replace_push(path_key: str, filing_type: str, schema_key: str):
  nonlocal_s = s
  pat = re.compile(rf'files\.push\(\s*\{{\s*path:\s*"{re.escape(path_key)}"[\s\S]*?\}}\s*\);\s*', re.M)
  m = pat.search(nonlocal_s)
  if not m:
    return nonlocal_s, False
  repl = f'''
    // --- {filing_type} (real if present, else stub) ---
    const __{schema_key} = await __readIncidentFiling(orgId, incidentId, "{filing_type}");
    const __{schema_key}Payload = __{schema_key}?.payload || {{ "_placeholder": "INIT" }};
    files.push({{
      path: "{path_key}",
      bytes: utf8(JSON.stringify({{
        ok: true,
        stub: __{schema_key} ? false : true,
        type: "{filing_type}",
        schemaVersion: __{schema_key}?.schemaVersion || "{schema_key}.v1",
        generatedAt: __{schema_key}?.generatedAt || nowIso,
        payload: __{schema_key}Payload
      }}, null, 2))
    }});
'''
  nonlocal_s = nonlocal_s[:m.start()] + repl + nonlocal_s[m.end():]
  return nonlocal_s, True

s, ok1 = replace_push("filings/dirs.json", "DIRS", "dirs")
s, ok2 = replace_push("filings/oe417.json", "OE_417", "oe_417")

if not ok1:
  raise SystemExit('❌ Could not find files.push() block for "filings/dirs.json" in route.ts')
if not ok2:
  raise SystemExit('❌ Could not find files.push() block for "filings/oe417.json" in route.ts')

p.write_text(s)
print("✅ patched packet zip route: uses incident_filings for DIRS + OE_417")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: generateFilingsV1 then download packet"
BASE="http://127.0.0.1:3000"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" >/dev/null || true

TMP="/tmp/packet_dirs_oe417_$TS"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123" -o "$TMP/p.zip"

echo "-- dirs.json --"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 500; echo
echo "-- oe417.json --"
unzip -p "$TMP/p.zip" "filings/oe417.json" | head -c 500; echo

echo
echo "✅ If those show stub:false + real payload fields, you're done for DIRS/OE417."
