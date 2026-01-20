#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${ROOT}" ]; then ROOT="$HOME/peakops/my-app"; fi
cd "$ROOT"

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

TS="$(date +%Y%m%d_%H%M%S)"
cp -f "functions_clean/index.js" "scripts/dev/_bak/functions_clean_index_${TS}.js" 2>/dev/null || true

echo "==> (1) write functions_clean/getIncidentBundleV1.js"
cat > functions_clean/getIncidentBundleV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

exports.getIncidentBundleV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);
    const snap = await incidentRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const incident = snap.data() || {};
    if (incident.orgId && String(incident.orgId) !== orgId) {
      return res.status(403).json({ ok: false, error: "orgId mismatch" });
    }

    // filings: prefer subcollection "filings", fallback to incident.filings array
    let filings = [];
    const filingsSnap = await incidentRef.collection("filings").get();
    if (!filingsSnap.empty) filings = filingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    else if (Array.isArray(incident.filings)) filings = incident.filings;

    // timeline optional
    let timeline = [];
    try {
      const tlSnap = await incidentRef.collection("timeline").orderBy("occurredAt", "asc").limit(200).get();
      timeline = tlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {}

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      incident,
      filings,
      timelineCount: timeline.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/getIncidentBundleV1.js"

echo "==> (2) register export in functions_clean/index.js (CommonJS)"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.readFileSync(p, "utf8");

const line = 'exports.getIncidentBundleV1 = require("./getIncidentBundleV1").getIncidentBundleV1;';
if (!s.includes(line)) {
  s += "\n// --- Incident bundle (Phase 2)\n" + line + "\n";
  fs.writeFileSync(p, s);
  console.log("✅ registered getIncidentBundleV1 in functions_clean/index.js");
} else {
  console.log("ℹ️ getIncidentBundleV1 already registered");
}
NODE

echo "==> (3) restart emulators"
pkill -f "firebase emulators" 2>/dev/null || true
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 120 .logs/emulators.log; exit 1; }

echo "==> smoke getIncidentBundleV1"
URL="$FN_BASE/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
echo "URL: $URL"
curl -fsS "$URL" | head -c 1000; echo

echo
echo "✅ getIncidentBundleV1 ONLINE"
echo "STOP: kill $EMU_PID"
