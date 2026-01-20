#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p .logs scripts/dev/_bak

F_DIR="functions_clean"
IDX="$F_DIR/index.mjs"
WF="$F_DIR/getWorkflowV1.mjs"

echo "==> (0) backup"
cp "$IDX" "scripts/dev/_bak/index.mjs.$TS.bak"
cp "$WF"  "scripts/dev/_bak/getWorkflowV1.mjs.$TS.bak"
echo "✅ backups saved to scripts/dev/_bak/*.$TS.bak"

echo "==> (1) write clean getWorkflowV1 handler (default export)"
cat > "$WF" <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

// Default export: plain handler function (req,res). Index wraps it with onRequest().
export default async function getWorkflowV1Handler(req, res) {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // Optional: fetch incident doc if present
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const steps = [
      { key: "intake",   title: "Intake",          hint: "Confirm incident exists + baseline fields.",             status: "TODO" },
      { key: "timeline", title: "Build Timeline",  hint: "Generate timeline events + verify ordering.",           status: "TODO" },
      { key: "filings",  title: "Generate Filings",hint: "Build DIRS/OE-417/NORS/SAR payloads.",                  status: "TODO" },
      { key: "export",   title: "Export Packet",   hint: "Create immutable shareable artifact (ZIP + hashes).",   status: "TODO" },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.stack || e) });
  }
}
MJS
echo "✅ wrote $WF"

echo "==> (2) patch index.mjs: ensure single clean export const getWorkflowV1"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/index.mjs")
s = p.read_text()

# Remove any prior getWorkflowV1 import/exports to avoid duplicates
s = re.sub(r'^\s*import\s+getWorkflowV1Handler\s+from\s+"\./getWorkflowV1\.mjs";\s*$', "", s, flags=re.M)
s = re.sub(r'^\s*import\s+getWorkflowV1\s+from\s+"\./getWorkflowV1\.mjs";\s*$', "", s, flags=re.M)
s = re.sub(r'^\s*export\s+\{\s*getWorkflowV1\s*\}\s+from\s+"\./getWorkflowV1\.mjs";\s*$', "", s, flags=re.M)
s = re.sub(r'^\s*export\s+const\s+getWorkflowV1\s*=\s*onRequest\([\s\S]*?\);\s*$', "", s, flags=re.M)

# Ensure onRequest import exists (most of your file already has this, but we guard)
if 'from "firebase-functions/v2/https"' in s and "onRequest" not in s.split('from "firebase-functions/v2/https"')[0]:
    # nothing (rare edge)
    pass

# Insert handler import near top (after other imports)
lines = s.splitlines()
insert_at = 0
for i, line in enumerate(lines):
    if line.strip().startswith("import "):
        insert_at = i + 1
lines.insert(insert_at, 'import getWorkflowV1Handler from "./getWorkflowV1.mjs";')

s = "\n".join(lines).strip() + "\n"

# Add export at end (clean, single)
if "export const getWorkflowV1" not in s:
    s += '\nexport const getWorkflowV1 = onRequest({ cors: true }, getWorkflowV1Handler);\n'

p.write_text(s)
print("✅ patched functions_clean/index.mjs (clean getWorkflowV1 export)")
PY

echo "==> (3) restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "functions_emulator" 2>/dev/null || true
rm -f .logs/emulators.log || true

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulators did not come up"
  tail -n 120 .logs/emulators.log || true
  exit 1
}
echo "✅ emulators ready (pid=$EMU_PID)"

echo "==> (4) smoke direct function"
curl -sS "$FN_BASE/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true
echo

echo "==> (5) smoke via Next proxy"
curl -i "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -n 20 || true
echo
echo "✅ if direct shows ok:true AND Next proxy is 200, Guided Workflow UI should go green."

echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "STOP:"
echo "  kill $EMU_PID"
