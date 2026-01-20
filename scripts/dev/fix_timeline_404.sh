#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="peakops-pilot"
FN_BASE_EMU="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> (0) backups"
mkdir -p scripts/dev/_bak
ts="$(date +%Y%m%d_%H%M%S)"
cp -f functions_clean/index.js "scripts/dev/_bak/index.js.${ts}" 2>/dev/null || true
cp -f next-app/.env.local "scripts/dev/_bak/next.env.local.${ts}" 2>/dev/null || true

echo "==> (1) Write functions_clean/getTimelineEventsV1.js (CommonJS, v2 onRequest)"
cat > functions_clean/getTimelineEventsV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();

function send(res, code, obj) {
  res.status(code).set("Content-Type", "application/json").send(JSON.stringify(obj));
}

exports.getTimelineEventsV1 = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET" });

    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId).collection("timelineEvents");

    // prefer occurredAt ordering; fall back to createdAt ordering if needed
    let snap;
    try {
      snap = await ref.orderBy("occurredAt", "asc").limit(limit).get();
    } catch {
      snap = await ref.orderBy("createdAt", "asc").limit(limit).get();
    }

    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return send(res, 200, { ok: true, orgId, incidentId, count: events.length, events });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});
JS
echo "✅ wrote functions_clean/getTimelineEventsV1.js"

echo "==> (2) Ensure functions_clean/index.js exports getTimelineEventsV1 (alias getTimelineEvents)"
# Append safely if missing
if ! rg -n "getTimelineEventsV1|getTimelineEvents" functions_clean/index.js >/dev/null 2>&1; then
  cat >> functions_clean/index.js <<'JS'

/* --- Timeline Events API --- */
const { getTimelineEventsV1 } = require("./getTimelineEventsV1");
exports.getTimelineEventsV1 = getTimelineEventsV1;
// alias (what Next proxy will call)
exports.getTimelineEvents = getTimelineEventsV1;
JS
  echo "✅ appended exports to functions_clean/index.js"
else
  echo "ℹ️ functions_clean/index.js already mentions timeline exports (skipping append)"
fi

echo "==> (3) Write Next proxy route: /api/fn/getTimelineEvents"
mkdir -p next-app/src/app/api/fn/getTimelineEvents
cat > next-app/src/app/api/fn/getTimelineEvents/route.ts <<'TS'
import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "getTimelineEvents");
}
TS
echo "✅ wrote next-app/src/app/api/fn/getTimelineEvents/route.ts"

echo "==> (4) Point Next to emulator FN_BASE (next-app/.env.local)"
cat > next-app/.env.local <<ENV
FN_BASE="${FN_BASE_EMU}"
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID="org_001"
ENV

echo "✅ wrote next-app/.env.local"
echo "    FN_BASE=${FN_BASE_EMU}"

echo "==> (5) restart stack (kill ports + emulators + next)"
lsof -tiTCP:3000,5001,8081,8080,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

mkdir -p .logs
firebase emulators:start --only functions,firestore --project "${PROJECT_ID}" > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 2

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2

echo "==> (6) smoke: functions + timeline route"
curl -fsS "${FN_BASE_EMU}/hello" | head -c 120; echo

echo "==> timeline via Next proxy"
curl -fsS "http://127.0.0.1:3000/api/fn/getTimelineEvents?orgId=org_001&incidentId=inc_TEST&limit=50" | head -c 300; echo

echo
echo "✅ STACK OK"
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
