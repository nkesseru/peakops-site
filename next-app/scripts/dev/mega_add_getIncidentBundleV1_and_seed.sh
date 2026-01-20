#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
CONTRACT_ID="${4:-car_abc123}"

# Resolve repo root (expects next-app/ and functions_clean/ siblings)
ROOT="$(pwd)"
if [ ! -d "$ROOT/next-app" ] || [ ! -d "$ROOT/functions_clean" ]; then
  # try one level up (if you're currently inside next-app/)
  if [ -d "../next-app" ] && [ -d "../functions_clean" ]; then
    ROOT="$(cd .. && pwd)"
  else
    echo "❌ Could not locate repo root. Run from my-app/ (must contain next-app/ and functions_clean/)."
    echo "   Current dir: $(pwd)"
    exit 1
  fi
fi

cd "$ROOT"
mkdir -p scripts/dev .logs

echo "==> ROOT=$ROOT"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID CONTRACT_ID=$CONTRACT_ID"

# ---------- (1) Functions: write getIncidentBundleV1 ----------
FUNC_DIR="functions_clean"
FUNC_FILE="$FUNC_DIR/getIncidentBundleV1.js"

cat > "$FUNC_FILE" <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getIncidentBundleV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // incident doc (safe read)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    if (!incident) return send(res, 404, { ok: false, error: "Incident not found" });

    // filings subcollection (safe read)
    let filings = [];
    try {
      const q = await db
        .collection("incidents")
        .doc(incidentId)
        .collection("filings")
        .orderBy("updatedAt", "desc")
        .limit(200)
        .get();

      filings = q.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}

    return send(res, 200, { ok: true, orgId, incidentId, incident, filings });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS

echo "✅ wrote $FUNC_FILE"

# Ensure functions_clean/index.js exports it
INDEX="$FUNC_DIR/index.js"
if [ ! -f "$INDEX" ]; then
  echo "❌ Missing $INDEX (functions_clean/index.js)."
  exit 1
fi

LINE='exports.getIncidentBundleV1 = require("./getIncidentBundleV1").getIncidentBundleV1;'
if ! grep -qF "$LINE" "$INDEX"; then
  printf "\n// --- Incident bundle (Phase 2)\n%s\n" "$LINE" >> "$INDEX"
  echo "✅ appended export to $INDEX"
else
  echo "ℹ️ index.js already exports getIncidentBundleV1"
fi

# ---------- (2) Next: proxy route ----------
ROUTE_DIR="next-app/src/app/api/fn/getIncidentBundleV1"
ROUTE_FILE="$ROUTE_DIR/route.ts"
mkdir -p "$ROUTE_DIR"
cat > "$ROUTE_FILE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "getIncidentBundleV1");
}
TS
echo "✅ wrote $ROUTE_FILE"

# ---------- (3) Hard restart stack ----------
echo "==> hard kill common ports + stray procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello (max ~40s)"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 160 .logs/emulators.log; exit 1; }
echo "✅ emulator ready"

echo "==> seed incident + filings into Firestore emulator"
node <<'NODE'
const admin = require("firebase-admin");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp({ projectId: process.env.PROJECT_ID });

const db = getFirestore();
db.settings({ host: process.env.FIRESTORE_EMULATOR_HOST, ssl: false });

const ORG_ID = process.env.ORG_ID;
const INCIDENT_ID = process.env.INCIDENT_ID;
const CONTRACT_ID = process.env.CONTRACT_ID;

(async () => {
  const now = FieldValue.serverTimestamp();

  await db.collection("incidents").doc(INCIDENT_ID).set({
    orgId: ORG_ID,
    incidentId: INCIDENT_ID,
    contractId: CONTRACT_ID,
    title: "Test Incident",
    status: "OPEN",
    createdAt: now,
    updatedAt: now,
  }, { merge: true });

  const filings = [
    { id: "dirs", type: "DIRS", schemaVersion: "dirs.v1", status: "STUB" },
    { id: "oe417", type: "OE_417", schemaVersion: "oe_417.v1", status: "STUB" },
    { id: "nors", type: "NORS", schemaVersion: "nors.v1", status: "STUB" },
    { id: "sar", type: "SAR", schemaVersion: "sar.v1", status: "STUB" },
    { id: "baba", type: "BABA", schemaVersion: "baba.v1", status: "STUB" },
  ];

  for (const f of filings) {
    await db.collection("incidents").doc(INCIDENT_ID).collection("filings").doc(f.id).set({
      orgId: ORG_ID,
      incidentId: INCIDENT_ID,
      ...f,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
  }

  console.log("✅ seeded incident + filings:", INCIDENT_ID);
})();
NODE

# Provide envs for node seed
# (node already ran; this is here so it's explicit in logs)
true

echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke DIRECT function"
curl -fsS "$FN_BASE/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 900; echo

echo "==> smoke NEXT proxy"
curl -fsS "$BASE/api/fn/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 900; echo

echo
echo "==> smoke UI routes"
curl -fsS "$BASE/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}" >/dev/null && echo "✅ incidents page OK"
curl -fsS "$BASE/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}" >/dev/null && echo "✅ bundle page OK"

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $BASE/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  $BASE/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 160 .logs/emulators.log"
echo "  tail -n 160 .logs/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"
