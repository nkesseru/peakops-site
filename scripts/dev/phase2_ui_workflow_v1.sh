#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

ROOT="$(pwd)"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> Phase2 UI Workflow v1 boot"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID"
echo

echo "==> (0) Hard-kill stray listeners (safe ports)"
lsof -tiTCP:3000,3001,3002,5001,8080,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# ----------------------------
# (1) Functions: getWorkflowV1
# ----------------------------
echo "==> (1) Write functions_clean/getWorkflowV1.mjs"
cat > functions_clean/getWorkflowV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

function nowIso() {
  return new Date().toISOString();
}

// Minimal workflow response for Phase 2 UI.
// Later we’ll make this smart (status gates, next actions, audit trail).
export default onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const db = getFirestore();

    // Try to read incident (optional)
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incident = incSnap.exists ? { id: incSnap.id, ...incSnap.data() } : null;

    // Basic deterministic “guided steps” (placeholder)
    const steps = [
      { key: "intake", title: "Intake", status: incident ? "DONE" : "TODO", hint: "Confirm incident exists + has baseline fields." },
      { key: "timeline", title: "Build Timeline", status: "TODO", hint: "Generate timeline events + verify ordering." },
      { key: "filings", title: "Generate Filings", status: "TODO", hint: "Build DIRS/OE-417/NORS/SAR payloads." },
      { key: "packet", title: "Export Packet", status: "TODO", hint: "Create immutable shareable artifact (ZIP + hashes)." },
    ];

    return res.json({
      ok: true,
      orgId,
      incidentId,
      asOf: nowIso(),
      incident,
      workflow: {
        version: "v1",
        steps,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
MJS

echo "==> (2) Wire getWorkflowV1 into functions_clean/index.mjs (import+export)"
# ensure import exists
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# Import line (idempotent)
imp = 'import getWorkflowV1 from "./getWorkflowV1.mjs";\n'
if imp not in s:
    # place near top after other imports
    lines = s.splitlines(True)
    insert_at = 0
    for i,l in enumerate(lines):
        if l.startswith("import "):
            insert_at = i+1
    lines.insert(insert_at, imp)
    s = "".join(lines)

# Export line (idempotent)
exp = "\nexport const getWorkflowV1 = getWorkflowV1;\n"
# we want: export const getWorkflowV1 = onRequest(getWorkflowV1Handler) style isn't needed because file already exports onRequest default
# BUT index.mjs expects to export constants. We'll re-export default under name getWorkflowV1 by direct assignment.
if "export const getWorkflowV1" not in s:
    # append near other exports (end of file)
    s = s.rstrip() + exp

p.write_text(s)
print("✅ functions_clean/index.mjs patched")
PY

# ---------------------------------------
# (3) Next proxy: /api/fn/getWorkflowV1
# ---------------------------------------
echo "==> (3) Write next-app proxy route /api/fn/getWorkflowV1"
mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Dev fallback so UI doesn’t hard-fail when orgId missing
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }

  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getWorkflowV1");
}
TS
echo "✅ wrote next-app/src/app/api/fn/getWorkflowV1/route.ts"

# ---------------------------------------
# (4) UI: Workflow panel on incidents page
# ---------------------------------------
echo "==> (4) Add WorkflowPanel component"
mkdir -p next-app/src/app/admin/incidents/_components
cat > next-app/src/app/admin/incidents/_components/WorkflowPanel.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";

type Step = { key: string; title: string; status: string; hint?: string };

export default function WorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [steps, setSteps] = useState<Step[]>([]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setSteps(j.workflow?.steps || []);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setSteps([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const pill = (status: string) => {
    const isDone = status === "DONE";
    const isTodo = status === "TODO";
    return (
      <span style={{
        fontSize: 11,
        fontWeight: 900,
        padding: "4px 8px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: isDone ? "color-mix(in oklab, lime 18%, transparent)" : isTodo ? "color-mix(in oklab, orange 18%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
      }}>
        {status}
      </span>
    );
  };

  return (
    <div style={{ display:"grid", gap: 10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap: 10 }}>
        <div style={{ fontWeight: 900 }}>Guided Workflow</div>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            cursor: busy ? "not-allowed" : "pointer"
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display:"grid", gap: 8 }}>
        {steps.map(s => (
          <div key={s.key}
            style={{
              display:"grid",
              gridTemplateColumns: "180px 1fr",
              gap: 10,
              padding: 12,
              borderRadius: 14,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "color-mix(in oklab, CanvasText 4%, transparent)"
            }}
          >
            <div style={{ display:"flex", gap: 10, alignItems:"center" }}>
              <div style={{ fontWeight: 900 }}>{s.title}</div>
              {pill(s.status)}
            </div>
            <div style={{ opacity: 0.85, fontSize: 13 }}>{s.hint || ""}</div>
          </div>
        ))}
        {(!busy && !err && steps.length === 0) && (
          <div style={{ opacity: 0.7 }}>No workflow steps yet.</div>
        )}
      </div>
    </div>
  );
}
TSX

echo "==> (5) Patch incidents/[id]/page.tsx to render WorkflowPanel (safe insert)"
python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure import
imp = 'import WorkflowPanel from "../_components/WorkflowPanel";\n'
if imp not in s:
    # place after other imports
    lines = s.splitlines(True)
    insert_at = 0
    for i,l in enumerate(lines):
        if l.startswith("import "):
            insert_at = i+1
    lines.insert(insert_at, imp)
    s = "".join(lines)

# Insert PanelCard section if not present
marker = 'title="System & User Logs"'
if "Guided Workflow" not in s:
    if marker in s:
        idx = s.find(marker)
        # insert before System & User Logs panel card
        insert_pt = s.rfind("<PanelCard", 0, idx)
        block = '''
        <PanelCard title="Guided Workflow">
          <WorkflowPanel orgId={orgId} incidentId={incidentId} />
        </PanelCard>

'''
        s = s[:insert_pt] + block + s[insert_pt:]
    else:
        # fallback: append near end before return closes
        s = s + "\n/* TODO: insert Guided Workflow panel manually */\n"

p.write_text(s)
print("✅ patched incidents page")
PY

# ---------------------------------------
# (6) Boot emulators + Next
# ---------------------------------------
echo "==> (6) Start emulators (functions+firestore) + Next"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

# Start Next
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!

echo "==> wait for Next :3000"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo "==> smoke getWorkflowV1"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
