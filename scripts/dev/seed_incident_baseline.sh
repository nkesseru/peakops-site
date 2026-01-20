#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ORG_ID="${ORG_ID:-org_001}"
INCIDENT_ID="${INCIDENT_ID:-inc_TEST}"

echo "==> Seeding incident baseline"
echo "    orgId=$ORG_ID"
echo "    incidentId=$INCIDENT_ID"

node <<'NODE'
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "peakops-pilot",
  });
}

const db = admin.firestore();

(async () => {
  const orgId = process.env.ORG_ID || "org_001";
  const incidentId = process.env.INCIDENT_ID || "inc_TEST";

  await db.collection("incidents").doc(incidentId).set(
    {
      id: incidentId,
      orgId,
      status: "OPEN",
      severity: "UNKNOWN",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),

      // future-proof fields
      source: "seed",
      notes: "Seeded baseline incident for workflow activation",
    },
    { merge: true }
  );

  console.log("✅ Incident seeded:", incidentId, "org:", orgId);
})();
NODE

echo "==> Smoke check: workflow should auto-complete Intake"
curl -fsS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 300
echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo
echo "🎉 Incident baseline seeded"
