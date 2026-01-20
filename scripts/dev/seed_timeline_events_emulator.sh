#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"
FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8081}"

echo "==> Seeding timelineEvents into Firestore emulator"
echo "    orgId=$ORG_ID incidentId=$INCIDENT_ID project=$PROJECT_ID host=$FIRESTORE_EMULATOR_HOST"

export FIRESTORE_EMULATOR_HOST
export GCLOUD_PROJECT="$PROJECT_ID"

node <<'NODE'
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

(async () => {
  const orgId = process.env.ORG_ID || "org_001";
  const incidentId = process.env.INCIDENT_ID || "inc_TEST";

  const incRef = db.collection("incidents").doc(incidentId);

  // Ensure incident exists (baseline)
  await incRef.set(
    {
      id: incidentId,
      orgId,
      status: "OPEN",
      severity: "UNKNOWN",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      source: "seed",
    },
    { merge: true }
  );

  const now = Date.now();
  const events = [
    {
      id: "t0_created",
      type: "INCIDENT_CREATED",
      title: "Incident created",
      message: "Basic incident record exists.",
      occurredAt: new Date(now - 15 * 60 * 1000).toISOString(),
    },
    {
      id: "t1_timeline",
      type: "TIMELINE_GENERATED",
      title: "Timeline generated",
      message: "Events ordered oldest → newest.",
      occurredAt: new Date(now - 10 * 60 * 1000).toISOString(),
    },
    {
      id: "t2_filings",
      type: "FILINGS_GENERATED",
      title: "Filings generated",
      message: "DIRS / OE-417 / NORS / SAR payloads created.",
      occurredAt: new Date(now - 5 * 60 * 1000).toISOString(),
    },
  ];

  const batch = db.batch();
  const col = incRef.collection("timelineEvents");
  for (const e of events) {
    batch.set(col.doc(e.id), {
      ...e,
      orgId,
      incidentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }

  batch.set(incRef, {
    timelineMeta: {
      generatedAt: new Date().toISOString(),
      eventCount: events.length,
      source: "seed",
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
  console.log("✅ seeded timelineEvents:", events.length);
})();
NODE
