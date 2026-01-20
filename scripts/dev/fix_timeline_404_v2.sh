#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

FN_BASE_EMU="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> (0) backups"
ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs
[ -f firebase.json ] && cp firebase.json "scripts/dev/_bak/firebase.json.${ts}" || true
[ -f functions_clean/index.js ] && cp functions_clean/index.js "scripts/dev/_bak/functions_clean.index.js.${ts}" || true
[ -f next-app/src/app/api/fn/getTimelineEvents/route.ts ] && cp next-app/src/app/api/fn/getTimelineEvents/route.ts "scripts/dev/_bak/getTimelineEvents.route.ts.${ts}" || true

echo "==> (1) force firebase.json functions.source = functions_clean"
python3 - <<'PY'
import json
from pathlib import Path
p=Path("firebase.json")
j=json.loads(p.read_text()) if p.exists() else {}
j.setdefault("functions", {})
j["functions"]["source"]="functions_clean"
p.write_text(json.dumps(j, indent=2))
print("✅ firebase.json -> functions_clean")
PY

echo "==> (2) ensure functions_clean is CommonJS + has deps"
python3 - <<'PY'
import json
from pathlib import Path
p=Path("functions_clean/package.json")
j=json.loads(p.read_text()) if p.exists() else {"name":"functions_clean","private":True}
j["main"]="index.js"
# don't force type=commonjs if you already have it; but it helps emulator stability
j["type"]="commonjs"
p.write_text(json.dumps(j, indent=2))
print("✅ functions_clean/package.json set to commonjs")
PY

echo "==> (3) write functions_clean/getTimelineEventsV1.js"
cat > functions_clean/getTimelineEventsV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getTimelineEventsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);

    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incRef = db.collection("incidents").doc(incidentId);

    // Optional: check org match if the doc exists
    const incSnap = await incRef.get();
    if (incSnap.exists) {
      const data = incSnap.data() || {};
      if (data.orgId && String(data.orgId) !== orgId) {
        return send(res, 404, { ok: false, error: "Incident not found" });
      }
    }

    // Pull timelineEvents subcollection if present
    let q = incRef.collection("timelineEvents").orderBy("occurredAt", "asc").limit(limit);
    const snap = await q.get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      count: docs.length,
      docs,
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/getTimelineEventsV1.js"

echo "==> (4) ensure functions_clean/index.js exports getTimelineEventsV1 + alias getTimelineEvents"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
if (!s.includes("getTimelineEventsV1")) {
  s += `\n// ---- Timeline Events ----\n`;
  s += `exports.getTimelineEventsV1 = require("./getTimelineEventsV1").getTimelineEventsV1;\n`;
}
if (!s.includes("exports.getTimelineEvents =")) {
  s += `exports.getTimelineEvents = exports.getTimelineEventsV1;\n`;
}
fs.writeFileSync(p, s);
console.log("✅ ensured exports in functions_clean/index.js");
NODE

echo "==> (5) write Next proxy route /api/fn/getTimelineEvents"
mkdir -p next-app/src/app/api/fn/getTimelineEvents
cat > next-app/src/app/api/fn/getTimelineEvents/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  // IMPORTANT: function alias in emulator is getTimelineEvents (points to getTimelineEventsV1)
  return proxyGET(req, "getTimelineEvents");
}
TS
echo "✅ wrote next-app/src/app/api/fn/getTimelineEvents/route.ts"

echo "==> (6) point Next to emulator FN_BASE"
cat > next-app/.env.local <<ENV
FN_BASE="${FN_BASE_EMU}"
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID="${ORG_ID}"
ENV
echo "✅ wrote next-app/.env.local"
echo "    FN_BASE=${FN_BASE_EMU}"

echo "==> (7) hard restart stack (clean ports)"
lsof -tiTCP:3000,5001,8081,8080,4000,4400,4409,4500,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

mkdir -p .logs
firebase emulators:start --only functions,firestore --project "${PROJECT_ID}" > .logs/emulators.log 2>&1 &
EMU_PID=$!

# wait for hello to exist
for i in $(seq 1 160); do
  curl -fsS "${FN_BASE_EMU}/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

# wait for Next
for i in $(seq 1 160); do
  curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> (8) smoke: hello"
curl -fsS "${FN_BASE_EMU}/hello" | head -c 120; echo

echo "==> (9) smoke: workflow + timeline (via Next proxy)"
curl -fsS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 180; echo
curl -fsS "http://127.0.0.1:3000/api/fn/getTimelineEvents?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50" | head -c 260; echo

echo
echo "✅ STACK OK"
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
