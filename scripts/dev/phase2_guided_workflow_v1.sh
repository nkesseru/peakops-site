#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Sanity"
test -d functions_clean || { echo "❌ missing functions_clean"; exit 1; }
test -d next-app || { echo "❌ missing next-app"; exit 1; }
echo "==> (1) Write functions_clean/workflowV1.mjs"

cat > functions_clean/workflowV1.mjs <<'JS'
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function nowTs() { return Timestamp.now(); }

function uniq(arr) {
  return Array.from(new Set((arr || []).map(x => String(x))));
}

function stageProgress(stage) {
  const map = {
    INTAKE: 10,
    FILINGS_READY: 35,
    SUBMITTING: 60,
    SUBMITTED: 80,
    EXPORT_READY: 92,
    DONE: 100,
  };
  return map[String(stage || "INTAKE")] ?? 10;
}

function computeIncidentWorkflow({ incident, filings, timelineMeta, evidenceCount }) {
  const blockers = [];
  const warnings = [];

  const filingRequired = Array.isArray(incident?.filingTypesRequired) ? incident.filingTypesRequired : [];
  const byType = new Map((filings || []).map(f => [String(f.type || f.id), f]));

  // Filings exist?
  if ((filings || []).length === 0) blockers.push("No filings generated yet.");

  // Required filing presence
  for (const t of filingRequired) {
    if (!byType.has(String(t))) blockers.push(`Missing required filing: ${t}`);
  }

  // Status checks
  let allReadyOrSubmitted = true;
  let allSubmitted = true;

  for (const t of filingRequired) {
    const f = byType.get(String(t));
    if (!f) continue;
    const st = String(f.status || "DRAFT").toUpperCase();
    if (!(st === "READY" || st === "SUBMITTED")) allReadyOrSubmitted = false;
    if (st !== "SUBMITTED") allSubmitted = false;

    if (st === "DRAFT") warnings.push(`${t} is still DRAFT`);
    if (st === "READY") warnings.push(`${t} is READY (not submitted)`);
  }

  // Timeline
  if (!timelineMeta) blockers.push("Timeline not generated yet.");

  // Evidence locker
  if (!evidenceCount || Number(evidenceCount) <= 0) warnings.push("Evidence locker is empty.");

  // Stage
  let stage = "INTAKE";
  if (blockers.length === 0 && !allReadyOrSubmitted) stage = "FILINGS_READY";
  if (blockers.length === 0 && allReadyOrSubmitted && !allSubmitted) stage = "SUBMITTING";
  if (blockers.length === 0 && allSubmitted) stage = "SUBMITTED";
  if (blockers.length === 0 && allSubmitted) stage = "EXPORT_READY";

  return {
    stage,
    progress: stageProgress(stage),
    blockers: uniq(blockers),
    warnings: uniq(warnings),
    lastComputedAt: nowTs(),
  };
}

// GET /computeWorkflowV1?orgId=...&incidentId=...&persist=true|false
export async function computeWorkflowV1(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const persist = String(req.query.persist || "true").toLowerCase() !== "false";

    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const incident = { id: incSnap.id, ...(incSnap.data()||{}) };

    // filings
    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => ({ id: d.id, ...(d.data()||{}) }));

    // timeline meta (either on incident or bundle style)
    const timelineMeta = incident.timelineMeta || null;

    // evidence locker count
    const evSnap = await incRef.collection("evidence_locker").limit(1).get().catch(() => null);
    const evidenceCount = evSnap ? (await incRef.collection("evidence_locker").get()).size : 0;

    const workflow = computeIncidentWorkflow({ incident, filings, timelineMeta, evidenceCount });

    if (persist) {
      await incRef.set({ workflow, updatedAt: new Date().toISOString() }, { merge: true });
    }

    return res.json({ ok:true, orgId, incidentId, workflow, persisted: persist });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}

// GET /getWorkflowV1?orgId=...&incidentId=...
export async function getWorkflowV1(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    const db = getFirestore();
    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const inc = snap.data() || {};
    return res.json({ ok:true, orgId, incidentId, workflow: inc.workflow || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}

// POST /setWorkflowStageV1 { orgId, incidentId, stage, actor }
export async function setWorkflowStageV1(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const orgId = String(body.orgId || "");
    const incidentId = String(body.incidentId || "");
    const stage = String(body.stage || "");
    const actor = String(body.actor || "admin_ui");

    if (!orgId || !incidentId || !stage) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId/stage" });

    const allowed = new Set(["INTAKE","FILINGS_READY","SUBMITTING","SUBMITTED","EXPORT_READY","DONE"]);
    if (!allowed.has(stage)) return res.status(400).json({ ok:false, error:"Invalid stage" });

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const inc = snap.data() || {};
    const wf = inc.workflow || {};
    wf.stage = stage;
    wf.progress = stageProgress(stage);
    wf.lastComputedAt = nowTs();
    wf.actor = actor;

    await ref.set({ workflow: wf, updatedAt: new Date().toISOString() }, { merge: true });

    return res.json({ ok:true, orgId, incidentId, workflow: wf });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
JS

echo "==> (2) Ensure functions_clean/index.mjs exports workflow handlers"

python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

need = [
  'import { computeWorkflowV1, getWorkflowV1, setWorkflowStageV1 } from "./workflowV1.mjs";',
  'export const computeWorkflowV1 = onRequest(computeWorkflowV1);',
  'export const getWorkflowV1 = onRequest(getWorkflowV1);',
  'export const setWorkflowStageV1 = onRequest(setWorkflowStageV1);',
]

if "workflowV1.mjs" not in s:
  # insert import near top (after other imports)
  lines = s.splitlines(True)
  ins = 0
  for i,l in enumerate(lines):
    if l.startswith("import ") and "firebase-functions" in l:
      ins = i+1
  lines.insert(ins, need[0] + "\n")
  s = "".join(lines)

for stmt in need[1:]:
  if stmt not in s:
    s += "\n" + stmt + "\n"

p.write_text(s)
print("✅ index.mjs wired")
PY

# --------------------------------
# (3) NEXT API routes for workflow
# --------------------------------
echo "==> (3) Create Next proxy routes"

mkdir -p next-app/src/app/api/fn/computeWorkflowV1
cat > next-app/src/app/api/fn/computeWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function GET(req: Request) { return proxyGET(req, "computeWorkflowV1"); }
TS

mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function GET(req: Request) { return proxyGET(req, "getWorkflowV1"); }
TS

mkdir -p next-app/src/app/api/fn/setWorkflowStageV1
cat > next-app/src/app/api/fn/setWorkflowStageV1/route.ts <<'TS'
import { proxyPOST } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function POST(req: Request) { return proxyPOST(req, "setWorkflowStageV1"); }
TS

echo "✅ next api routes added"
echo "==> (4) Restart stack"
bash scripts/dev/dev-down.sh >/dev/null 2>&1 || true
bash scripts/dev/dev-up.sh

echo "==> (5) Smoke workflow endpoints"
set -a; source ./.env.dev.local 2>/dev/null || true; set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

# pick latest incident if exists
INCIDENT_ID="$(curl -sS "$FN_BASE/listIncidents?orgId=$ORG_ID" | python3 - <<'PY'
import sys,json
d=json.load(sys.stdin)
incs=d.get("incidents",[])
print(incs[0]["id"] if incs else "")
PY
)"
if [ -z "$INCIDENT_ID" ]; then
  echo "ℹ️ No incidents found. Create one first to see workflow."
else
  echo "✅ Using incident: $INCIDENT_ID"
  curl -sS "$FN_BASE/computeWorkflowV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&persist=true" | python3 -m json.tool | head -n 80
  curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | python3 -m json.tool | head -n 80
fi

echo
echo "✅ Phase 2 backend wired."
echo "Next step: add the Workflow Panel to /admin/incidents/[id]"
