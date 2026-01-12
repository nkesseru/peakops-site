#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="peakops-pilot"
ORG_ID="${ORG_ID:-org_001}"
INCIDENT_ID="${INCIDENT_ID:-inc_TEST}"

mkdir -p .logs scripts/dev/_bak

echo "==> backup getWorkflowV1.js"
ts="$(date +%Y%m%d_%H%M%S)"
cp -f functions_clean/getWorkflowV1.js "scripts/dev/_bak/getWorkflowV1.js.bak_${ts}" 2>/dev/null || true

echo "==> write getWorkflowV1.js (baseline auto + safe timeline + readiness flags)"
cat > functions_clean/getWorkflowV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function pickTs(x) {
  if (!x) return null;
  // Firestore Timestamp
  if (typeof x === "object" && typeof x._seconds === "number") return x._seconds * 1000;
  if (typeof x === "object" && typeof x.seconds === "number") return x.seconds * 1000;
  // ISO string
  if (typeof x === "string") {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // --- Incident read (optional but preferred) ---
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    const incidentOrg = incident?.orgId || incident?.orgid || null;
    const createdAtMs = pickTs(incident?.createdAt) ?? pickTs(incident?.created_at) ?? null;

    // Baseline valid = exists + org matches + has createdAt
    const baselineOk = !!(incident && incidentOrg && String(incidentOrg) === String(orgId) && createdAtMs);

    // --- Timeline (safe, but now anchored to incident.createdAt when present) ---
    const t0 = createdAtMs ? new Date(createdAtMs).toISOString() : null;
    const timeline = [
      { t: "T+0",   at: t0, title: "Incident created",   detail: "Basic incident record exists." },
      { t: "T+5m",  at: null, title: "Timeline generated", detail: "Events ordered oldest → newest." },
      { t: "T+10m", at: null, title: "Filings generated",  detail: "DIRS / OE-417 / NORS / SAR payloads created." },
      { t: "T+15m", at: null, title: "Packet exported",    detail: "ZIP + hashes produced for audit." },
    ];

    // --- Packet readiness (v1: read incident meta if present) ---
    const filingsReady = !!incident?.filingsMeta;
    const exportReady  = !!incident?.packetMeta || !!incident?.packetHash || !!incident?.exportMeta;

    const steps = [
      { key: "intake",   title: "Intake",          hint: baselineOk ? "Baseline valid ✅ (auto)" : "Confirm incident exists + baseline fields.", status: baselineOk ? "DONE" : "TODO" },
      { key: "timeline", title: "Build Timeline",  hint: "Generate timeline events + verify ordering.", status: "TODO" },
      { key: "filings",  title: "Generate Filings",hint: "Build DIRS / OE-417 / NORS / SAR payloads.", status: filingsReady ? "DONE" : "TODO" },
      { key: "export",   title: "Export Packet",   hint: "Create immutable shareable artifact (ZIP + hashes).", status: exportReady ? "DONE" : "TODO" },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps, timeline, filingsReady, exportReady }
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});
JS

echo "==> restart stack (emulators + next)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project "${PROJECT_ID}" > .logs/emulators.log 2>&1 &
sleep 3
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke workflow API"
curl -fsS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENT PAGE OK" || { echo "❌ incidents page fail"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "✅ workflow spine v2 ACTIVE"
echo "OPEN:"
echo "  $URL"
