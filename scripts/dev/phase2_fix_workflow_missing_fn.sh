#!/usr/bin/env bash
set +H 2>/dev/null || true
set +H
set -euo pipefail
cd ~/peakops/my-app

echo "==> (0) Write functions_clean/getWorkflowV1.mjs"
cat > functions_clean/getWorkflowV1.mjs <<'MJS'
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export default async function getWorkflowV1(req, res) {
  try {
    res.set("Access-Control-Allow-Origin", "*");
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    if (!getApps().length) initializeApp();
    const db = getFirestore();

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const inc = incSnap.exists ? (incSnap.data() || {}) : {};

    const steps = [
      { key:"intake",  title:"Intake + Validate",      status:"READY" },
      { key:"packet",  title:"Evidence Packet",        status:"READY" },
      { key:"filings", title:"Prepare Filings",        status:"READY" },
      { key:"submit",  title:"Submit + Record Receipt",status:"TODO"  },
    ];

    return res.json({
      ok:true,
      orgId,
      incidentId,
      incident: { id: incidentId, title: inc.title || null, status: inc.status || null },
      steps,
      version: "v1",
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/getWorkflowV1.mjs"

echo "==> (1) Wire into functions_clean/index.mjs"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

imp = 'import getWorkflowV1Handler from "./getWorkflowV1.mjs";\n'
if "getWorkflowV1Handler" not in s:
    # prepend import (safe + simple)
    s = imp + s

export_line = 'export const getWorkflowV1 = onRequest(getWorkflowV1Handler);\n'
if "export const getWorkflowV1" not in s:
    anchor = "export const hello"
    i = s.find(anchor)
    if i != -1:
        # insert right after hello line block
        end = s.find("\n", i)
        s = s[:end+1] + export_line + s[end+1:]
    else:
        s += "\n" + export_line

# dedupe import if repeated
lines = s.splitlines(True)
seen = 0
out = []
for ln in lines:
    if 'import getWorkflowV1Handler from "./getWorkflowV1.mjs";' in ln:
        seen += 1
        if seen > 1:
            continue
    out.append(ln)
Path("functions_clean/index.mjs").write_text("".join(out))
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (2) Patch canonical emulator bundler to include getWorkflowV1"
BOOT="scripts/dev/boot_dev_stack_v2.sh"
test -f "$BOOT"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("scripts/dev/boot_dev_stack_v2.sh")
s = p.read_text()

# Ensure bundling list includes getWorkflowV1
if "getWorkflowV1.mjs" in s and "getWorkflowV1.cjs" in s:
    print("✅ boot_dev_stack_v2 already bundles getWorkflowV1")
    raise SystemExit(0)

# Try to patch a files=[ ... ] array of tuples
m = re.search(r'files\s*=\s*\[\s*(.*?)\s*\]\s*;?', s, re.S)
if m:
    block = m.group(0)
    if "getWorkflowV1" not in block:
        new_block = block.replace("];", '  ["getWorkflowV1.mjs", "getWorkflowV1.cjs"],\n];')
        s = s.replace(block, new_block, 1)
        p.write_text(s)
        print("✅ inserted getWorkflowV1 into files[] bundler list")
        raise SystemExit(0)

# Fallback: insert after getContractPayloadsV1 tuple line
lines = s.splitlines(True)
out=[]
inserted=False
for ln in lines:
    out.append(ln)
    if (not inserted) and ("getContractPayloadsV1.mjs" in ln):
        out.append('  ["getWorkflowV1.mjs", "getWorkflowV1.cjs"],\n')
        inserted=True
if not inserted:
    raise SystemExit("❌ Could not find bundler section in boot_dev_stack_v2.sh")
p.write_text("".join(out))
print("✅ inserted getWorkflowV1 (fallback)")
PY

echo "==> (3) Add Next proxy route /api/fn/getWorkflowV1"
mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  return proxyGET(new Request(url.toString(), { method:"GET", headers:req.headers }), "getWorkflowV1");
}
TS
echo "✅ wrote next-app/src/app/api/fn/getWorkflowV1/route.ts"

echo "==> (4) Reboot canonical stack"
CAN="scripts/dev/boot_contracts_stack_canonical.sh"
test -f "$CAN"
bash "$CAN" peakops-pilot org_001 car_abc123 v1

echo
echo "==> (5) Smoke getWorkflowV1 (direct + next)"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo

echo
echo "✅ If both return ok:true, Phase 2 backend is live."
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
