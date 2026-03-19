#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

# 1) Functions handler
cat > functions_clean/getWorkflowV1.mjs <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

export default async function getWorkflowV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const db = getFirestore();

    // Minimal “guided workflow” payload for Phase 2:
    // - status + steps array (you can evolve this later)
    const wfRef = db.collection("incidents").doc(incidentId).collection("workflows").doc("v1");
    const wfSnap = await wfRef.get();

    if (!wfSnap.exists) {
      // Safe default workflow (no Firestore write)
      return res.json({
        ok: true,
        orgId,
        incidentId,
        workflowId: "v1",
        status: "DRAFT",
        steps: [
          { key: "intake", title: "Intake", done: false },
          { key: "facts", title: "Facts & Timeline", done: false },
          { key: "filings", title: "Filings", done: false },
          { key: "evidence", title: "Evidence Locker", done: false },
          { key: "export", title: "Export Packet", done: false }
        ]
      });
    }

    return res.json({ ok: true, orgId, incidentId, workflowId: "v1", ...wfSnap.data() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS

echo "✅ wrote functions_clean/getWorkflowV1.mjs"

# 2) Export from functions_clean/index.mjs
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# ensure import
imp = 'import getWorkflowV1 from "./getWorkflowV1.mjs";\n'
if imp not in s:
    # place near other imports at top (after onRequest import)
    lines = s.splitlines(True)
    out = []
    inserted = False
    for i, line in enumerate(lines):
        out.append(line)
        if (not inserted) and line.startswith("import") and "firebase-functions" in line:
            # after first import line
            out.append(imp)
            inserted = True
    if not inserted:
        out.insert(0, imp)
    s = "".join(out)

# ensure export
exp = "export const getWorkflowV1 = onRequest(getWorkflowV1);\n"
if exp not in s:
    # put after hello export if present, else append at end
    anchor = "export const hello"
    idx = s.find(anchor)
    if idx != -1:
        end = s.find("\n", idx)
        s = s[:end+1] + exp + s[end+1:]
    else:
        s += "\n" + exp

p.write_text(s)
print("✅ patched functions_clean/index.mjs (import + export getWorkflowV1)")
PY

# 3) Next proxy route
mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  // dev default orgId so UI doesn’t hard-fail if query drops
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }

  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getWorkflowV1");
}
TS

echo "✅ wrote next-app/src/app/api/fn/getWorkflowV1/route.ts"

echo
echo "✅ Phase 2 backend wired. Now reboot stack:"
echo "  bash scripts/dev/boot_stack_v1.sh peakops-pilot org_001"
echo
echo "Smoke after boot:"
echo "  curl -sS 'http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST' | head -c 260; echo"
