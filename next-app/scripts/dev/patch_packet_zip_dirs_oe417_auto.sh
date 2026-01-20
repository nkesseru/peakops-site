#!/usr/bin/env bash
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
echo

echo "==> (1) Locate where dirs/oe417 are written in route.ts"
echo "---- hits for dirs ----"
rg -n 'dirs\.json|DIRS"|schemaVersion"\s*:\s*"dirs\.v1|filings/dirs' "$FILE" || true
echo
echo "---- hits for oe417 ----"
rg -n 'oe417\.json|OE_417"|schemaVersion"\s*:\s*"oe_417\.v1|filings/oe417' "$FILE" || true
echo

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# Ensure we have Firestore admin available
if "firebase-admin/firestore" not in s:
  s = re.sub(
    r'(from\s+"next/server";\s*\n)',
    r'\1import { initializeApp, getApps } from "firebase-admin/app";\nimport { getFirestore } from "firebase-admin/firestore";\n',
    s,
    count=1
  )

if "if (!getApps().length) initializeApp();" not in s:
  s = re.sub(
    r'(export async function GET\(req: Request\)\s*\{\s*)',
    r'\1\n  if (!getApps().length) initializeApp();\n  const db = getFirestore();\n',
    s,
    count=1
  )

# Add helper (only once)
if "__readIncidentFiling" not in s:
  s = re.sub(
    r'(const\s+incidentId\s*=.*?\n)',
    r'''\1
  async function __readIncidentFiling(type: string) {
    try {
      const qs = await db.collection("incident_filings")
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

''',
    s,
    count=1,
    flags=re.S
  )

def patch_any_writer(json_name: str, filing_type: str, schema: str):
  """
  Patch either:
    zip.file("filings/dirs.json", ...)
  OR:
    files.push({ path: "filings/dirs.json", bytes: ... })
  OR:
    any bytes assignment that mentions that filename
  """
  nonlocal s

  # zip.file(...) case
  pat_zip = re.compile(rf'zip\.file\(\s*["\']filings/{re.escape(json_name)}["\']\s*,\s*[\s\S]*?\);\s*', re.M)
  if pat_zip.search(s):
    repl = f'''
    // --- {filing_type} (real if present, else stub) ---
    const __{schema} = await __readIncidentFiling("{filing_type}");
    const __{schema}Payload = __{schema}?.payload || {{ "_placeholder": "INIT" }};
    zip.file(
      "filings/{json_name}",
      Buffer.from(JSON.stringify({{
        ok: true,
        stub: __{schema} ? false : true,
        type: "{filing_type}",
        schemaVersion: __{schema}?.schemaVersion || "{schema}.v1",
        generatedAt: __{schema}?.generatedAt || nowIso,
        payload: __{schema}Payload
      }}, null, 2), "utf8")
    );
'''
    s = pat_zip.sub(repl, s, count=1)
    return True

  # files.push({path:"filings/.."})
  pat_push = re.compile(rf'files\.push\(\s*\{{[\s\S]*?path:\s*["\']filings/{re.escape(json_name)}["\'][\s\S]*?\}}\s*\);\s*', re.M)
  if pat_push.search(s):
    repl = f'''
    // --- {filing_type} (real if present, else stub) ---
    const __{schema} = await __readIncidentFiling("{filing_type}");
    const __{schema}Payload = __{schema}?.payload || {{ "_placeholder": "INIT" }};
    files.push({{
      path: "filings/{json_name}",
      bytes: utf8(JSON.stringify({{
        ok: true,
        stub: __{schema} ? false : true,
        type: "{filing_type}",
        schemaVersion: __{schema}?.schemaVersion || "{schema}.v1",
        generatedAt: __{schema}?.generatedAt || nowIso,
        payload: __{schema}Payload
      }}, null, 2))
    }});
'''
    s = pat_push.sub(repl, s, count=1)
    return True

  return False

ok_dirs  = patch_any_writer("dirs.json",  "DIRS",   "dirs")
ok_oe417 = patch_any_writer("oe417.json", "OE_417", "oe_417")

if not ok_dirs:
  raise SystemExit('❌ Could not find where filings/dirs.json is written (zip.file or files.push). Run: rg -n "dirs.json|filings/dirs|DIRS\\"|dirs.v1" route.ts')
if not ok_oe417:
  raise SystemExit('❌ Could not find where filings/oe417.json is written (zip.file or files.push). Run: rg -n "oe417.json|filings/oe417|OE_417\\"|oe_417.v1" route.ts')

p.write_text(s)
print("✅ patched route.ts: DIRS + OE_417 now read from incident_filings")
PY

echo
echo "==> (2) restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (3) smoke: generate + download zip"
BASE="http://127.0.0.1:3000"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" >/dev/null || true

TMP="/tmp/packet_dirs_oe417_$TS"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123" -o "$TMP/p.zip"

echo "-- filings/dirs.json --"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 420; echo
echo "-- filings/oe417.json --"
unzip -p "$TMP/p.zip" "filings/oe417.json" | head -c 420; echo

echo
echo "✅ If you see stub:false, you’re good."
