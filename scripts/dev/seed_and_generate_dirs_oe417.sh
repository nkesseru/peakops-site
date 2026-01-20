#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"
CONTRACT_ID="${4:-car_abc123}"

# --- locate repo root (must contain next-app/) ---
ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi
cd "$ROOT"
echo "==> ROOT=$ROOT"

LOGDIR=".logs"
mkdir -p "$LOGDIR" "scripts/dev/_bak"

TS="$(date +%Y%m%d_%H%M%S)"

# --- hard kill old ports ---
echo "==> kill old ports (3000,5001,8081,4400,4409,9150)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# --- start emulators ---
echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 140); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 140 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulators ready (pid=$EMU_PID)"

# --- seed incident + filings directly into Firestore emulator ---
echo "==> seed incident + DIRS/OE417 filings into Firestore emulator"
node - <<NODE
process.env.GCLOUD_PROJECT = "${PROJECT_ID}";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8081";
const admin = require("firebase-admin");
try { admin.initializeApp({ projectId: "${PROJECT_ID}" }); } catch(e){}
const db = admin.firestore();

(async()=>{
  const orgId="${ORG_ID}";
  const incidentId="${INCIDENT_ID}";
  const contractId="${CONTRACT_ID}";

  const iref = db.collection("incidents").doc(incidentId);

  await iref.set({
    orgId,
    incidentId,
    contractId,
    status: "OPEN",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge:true });

  const nowIso = new Date().toISOString();

  // DIRS payload (minimal real-ish)
  await iref.collection("filings").doc("dirs").set({
    type: "DIRS",
    schemaVersion: "dirs.v1",
    status: "DRAFT",
    generatedAt: nowIso,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    payload: {
      schemaVersion: "dirs.v1",
      orgId,
      incidentId,
      contractId,
      outage: { status: "OPEN", startedAt: nowIso, type: "COMMUNICATIONS", description: "Seed DIRS payload" },
      contacts: [{ name:"Primary", role:"Incident Commander", phone:"", email:"" }],
    }
  }, { merge:true });

  // OE-417 payload (minimal real-ish)
  await iref.collection("filings").doc("oe417").set({
    type: "OE_417",
    schemaVersion: "oe_417.v1",
    status: "DRAFT",
    generatedAt: nowIso,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    payload: {
      schemaVersion: "oe_417.v1",
      orgId,
      incidentId,
      contractId,
      report: {
        reportType: "OE-417_INITIAL",
        eventStart: nowIso,
        situation: "Seed OE-417 payload",
        impacts: [{ sector:"Telecom", customersAffected: 0, notes:"" }],
      },
      contacts: [{ name:"Primary", role:"Reporting Official", phone:"", email:"" }],
    }
  }, { merge:true });

  console.log("✅ seeded incident + filings into emulator:", incidentId);
})();
NODE

# --- start Next ---
echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE_URL="http://127.0.0.1:3000"

echo "==> smoke: incident bundle route (Next proxy)"
curl -fsS "$BASE_URL/api/fn/getIncidentBundleV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 260; echo

echo "==> smoke: downloadIncidentPacketZip contains filings/dirs.json + filings/oe417.json"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&contractId=$CONTRACT_ID"
TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/p.zip"
unzip -l "$TMP/p.zip" | egrep "filings/(dirs|oe417)\.json" || {
  echo "❌ filings/dirs.json or filings/oe417.json missing in packet zip"
  unzip -l "$TMP/p.zip" | head -n 120
  echo
  echo "TAIL next.log:"
  tail -n 120 "$LOGDIR/next.log" || true
  exit 1
}
echo "✅ packet zip includes DIRS + OE417 files"

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
