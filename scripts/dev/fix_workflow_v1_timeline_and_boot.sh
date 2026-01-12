#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="peakops-pilot"
ORG_ID="${ORG_ID:-org_001}"
INCIDENT_ID="${INCIDENT_ID:-inc_TEST}"

mkdir -p .logs scripts/dev/_bak

echo "==> backups"
ts="$(date +%Y%m%d_%H%M%S)"
cp -f functions_clean/getWorkflowV1.js "scripts/dev/_bak/getWorkflowV1.js.bak_${ts}" 2>/dev/null || true
cp -f functions_clean/index.js "scripts/dev/_bak/functions_clean_index.js.bak_${ts}" 2>/dev/null || true
cp -f functions_clean/package.json "scripts/dev/_bak/functions_clean_package.json.bak_${ts}" 2>/dev/null || true
cp -f next-app/.env.local "scripts/dev/_bak/next_env.local.bak_${ts}" 2>/dev/null || true

echo "==> force functions_clean to CommonJS (emulator-friendly)"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
obj = json.loads(p.read_text())
obj["type"] = "commonjs"
if "main" not in obj:
  obj["main"] = "index.js"
p.write_text(json.dumps(obj, indent=2) + "\n")
print("✅ functions_clean/package.json -> commonjs")
PY

echo "==> write functions_clean/getWorkflowV1.js (NO undefined timeline)"
cat > functions_clean/getWorkflowV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) {
      return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });
    }

    // Optional incident read (safe even if collection doesn't exist yet)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    // Baseline rule (safe mode): we only auto-complete intake if incident exists + has a couple fields
    const baselineOk = !!(incident && (incident.orgId || incident.orgid) && incident.id);

    // Stub timeline preview (safe, always defined)
    const timeline = [
      { t: "T+0",   title: "Incident created",    detail: "Basic incident record exists." },
      { t: "T+5m",  title: "Timeline generated",  detail: "Events ordered oldest → newest." },
      { t: "T+10m", title: "Filings generated",   detail: "DIRS / OE-417 / NORS / SAR / BABA payloads created." },
      { t: "T+15m", title: "Packet exported",     detail: "ZIP + hashes produced for audit." },
    ];

    // Later we will compute these from real meta (filingsMeta / packet status / hashes)
    const filingsReady = false;
    const exportReady = false;

    const steps = [
      {
        key: "intake",
        title: "Intake",
        hint: "Confirm incident exists + has baseline fields.",
        status: baselineOk ? "DONE" : "TODO",
      },
      {
        key: "timeline",
        title: "Build Timeline",
        hint: "Generate timeline events + verify ordering.",
        status: "TODO",
      },
      {
        key: "filings",
        title: "Generate Filings",
        hint: "Build DIRS / OE-417 / NORS / SAR payloads.",
        status: filingsReady ? "DONE" : "TODO",
      },
      {
        key: "export",
        title: "Export Packet",
        hint: "Create immutable shareable artifact (ZIP + hashes).",
        status: exportReady ? "DONE" : "TODO",
      },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: {
        version: "v1",
        steps,
        timeline,
        filingsReady,
        exportReady,
      },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});
JS
echo "✅ wrote functions_clean/getWorkflowV1.js"

echo "==> ensure functions_clean/index.js exports getWorkflowV1"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.js")
s = p.read_text()

# If already exported, do nothing
if "getWorkflowV1" in s:
  print("ℹ️ functions_clean/index.js already mentions getWorkflowV1")
else:
  # safest: append a single export line
  s = s.rstrip() + "\n\nexports.getWorkflowV1 = require('./getWorkflowV1').getWorkflowV1;\n"
  p.write_text(s)
  print("✅ appended getWorkflowV1 export to functions_clean/index.js")
PY

echo "==> point Next to emulator FN_BASE"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
mkdir -p next-app
cat > next-app/.env.local <<EOF
FN_BASE=${FN_BASE}
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}
EOF
echo "✅ wrote next-app/.env.local"

echo "==> hard restart stack (ports + emulators + next)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project "${PROJECT_ID}" > .logs/emulators.log 2>&1 &
EMU_PID=$!

# wait for functions to be reachable
for i in $(seq 1 120); do
  curl -fsS "${FN_BASE}/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2

echo "==> smoke API (must include timeline)"
curl -fsS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 220; echo

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENT PAGE OK" || { echo "❌ incidents page fail"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "✅ STACK GREEN"
echo "OPEN:"
echo "  $URL"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
