#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mkdir -p .logs
echo "==> ROOT=$ROOT"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID"
FUNC_DIR="functions_clean"
FUNC_FILE="$FUNC_DIR/getIncidentBundleV1.js"

cat > "$FUNC_FILE" <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

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

    // incident read (safe)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    // filings (try incident-scoped first, fall back to empty)
    let filings = [];
    try {
      const q = await db
        .collection("incidents")
        .doc(incidentId)
        .collection("filings")
        .limit(50)
        .get();

      filings = q.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {
      // fallback: if incident has an inline filings array
      if (incident && Array.isArray(incident.filings)) filings = incident.filings;
    }

    return send(res, 200, { ok: true, orgId, incidentId, incident, filings });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS

echo "✅ wrote $FUNC_FILE"
INDEX="$FUNC_DIR/index.js"
if [ ! -f "$INDEX" ]; then
  echo "❌ Missing $INDEX — functions_clean doesn't look set up as expected."
  exit 1
fi

LINE='exports.getIncidentBundleV1 = require("./getIncidentBundleV1").getIncidentBundleV1;'

if ! grep -q 'getIncidentBundleV1' "$INDEX"; then
  printf "\n// --- Incident bundle (Phase 2)\n%s\n" "$LINE" >> "$INDEX"
  echo "✅ appended getIncidentBundleV1 export to $INDEX"
else
  # ensure exact line exists
  if ! grep -qF "$LINE" "$INDEX"; then
    printf "\n%s\n" "$LINE" >> "$INDEX"
    echo "✅ appended missing exact export line to $INDEX"
  else
    echo "ℹ️ $INDEX already exports getIncidentBundleV1"
  fi
fi
ROUTE_DIR="next-app/src/app/api/fn/getIncidentBundleV1"
ROUTE_FILE="$ROUTE_DIR/route.ts"
if [ ! -f "$ROUTE_FILE" ]; then
  mkdir -p "$ROUTE_DIR"
  cat > "$ROUTE_FILE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "getIncidentBundleV1");
}
TS
  echo "✅ wrote $ROUTE_FILE"
else
  echo "ℹ️ proxy already exists: $ROUTE_FILE"
fi

echo "==> hard kill common ports"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 160 .logs/emulators.log; exit 1; }
echo "✅ emulator ready"

echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke DIRECT function"
curl -fsS "$FN_BASE/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 900; echo
echo
echo "==> smoke NEXT proxy"
curl -fsS "$BASE/api/fn/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 900; echo

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
