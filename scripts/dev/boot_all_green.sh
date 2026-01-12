#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
CUSTOMER_ID="${4:-cust_acme_001}"
VERSION_ID="${5:-v1}"
INCIDENT_ID="${6:-inc_TEST}"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> (0) hard kill ports + stray dev/emulator procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150,4000 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "   emu pid: $EMU_PID"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> (2) wait for functions /hello (max ~30s)"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 160 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ functions emulator ready"

echo "==> (3) point Next to emulator (FN_BASE + default org)"
cat > next-app/.env.local <<EOF
FN_BASE=$FN_BASE
NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID
EOF
echo "✅ next-app/.env.local updated"

echo "==> (4) seed contract + payloads into Firestore emulator"
FIRESTORE_EMULATOR_HOST=127.0.0.1:8081 \
PROJECT_ID="$PROJECT_ID" ORG_ID="$ORG_ID" CONTRACT_ID="$CONTRACT_ID" CUSTOMER_ID="$CUSTOMER_ID" VERSION_ID="$VERSION_ID" \
bash scripts/dev/seed_contract_and_payloads_emulator.sh "$PROJECT_ID" "$ORG_ID" "$CONTRACT_ID" "$CUSTOMER_ID" "$VERSION_ID" \
  > "$LOGDIR/seed_contract.log" 2>&1 || {
    echo "❌ seed_contract failed"; tail -n 120 "$LOGDIR/seed_contract.log"; exit 1;
  }
echo "✅ seeded contract + payloads"

echo "==> (5) seed incident doc (lightweight) + timeline events"
node - <<'NODE'
const admin = require("firebase-admin");
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8081";

const PROJECT_ID = process.env.PROJECT_ID || "peakops-pilot";
const ORG_ID = process.env.ORG_ID || "org_001";
const INCIDENT_ID = process.env.INCIDENT_ID || "inc_TEST";

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

(async () => {
  // Minimal incident doc so "baseline" has something real later
  await db.collection("incidents").doc(INCIDENT_ID).set(
    {
      orgId: ORG_ID,
      status: "OPEN",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Seed timelineEvents (idempotent)
  const base = new Date();
  const t0 = new Date(base.getTime() - 15 * 60000);
  const t1 = new Date(base.getTime() - 10 * 60000);
  const t2 = new Date(base.getTime() - 5 * 60000);

  const events = [
    { id: "t0_created", title: "Incident created", message: "Basic incident record exists.", type: "INCIDENT_CREATED", occurredAt: t0.toISOString() },
    { id: "t1_timeline", title: "Timeline generated", message: "Events ordered oldest → newest.", type: "TIMELINE_GENERATED", occurredAt: t1.toISOString() },
    { id: "t2_filings", title: "Filings generated", message: "DIRS / OE-417 / NORS / SAR payloads created.", type: "FILINGS_GENERATED", occurredAt: t2.toISOString() },
  ];

  for (const ev of events) {
    await db.collection("timelineEvents").doc(ev.id).set(
      {
        ...ev,
        orgId: ORG_ID,
        incidentId: INCIDENT_ID,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  console.log("✅ seeded incidents/" + INCIDENT_ID + " + timelineEvents(3)");
})().catch((e) => {
  console.error("❌ seed incident/timeline failed:", e?.stack || e);
  process.exit(1);
});
NODE
echo "✅ seeded incident + timeline"

echo "==> (6) start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

echo "==> (7) smoke key routes"
BASE_URL="http://127.0.0.1:3000"
INC_URL="$BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
BUNDLE_URL="$BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"

curl -fsS "$INC_URL" >/dev/null || { echo "❌ incidents page 500"; tail -n 160 "$LOGDIR/next.log"; exit 1; }
curl -fsS "$BUNDLE_URL" >/dev/null || { echo "❌ bundle page 500"; tail -n 160 "$LOGDIR/next.log"; exit 1; }

echo "✅ STACK UP"
echo "OPEN:"
echo "  $INC_URL"
echo "  $BUNDLE_URL"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
