#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export GCLOUD_PROJECT="peakops-pilot"

ORG_ID="${1:-org_001}"
CONTRACT_ID="${2:-car_abc123}"
CUSTOMER_ID="${3:-cust_acme_001}"

node <<'NODE'
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

(async () => {
  const orgId = process.env.ORG_ID;
  const contractId = process.env.CONTRACT_ID;
  const customerId = process.env.CUSTOMER_ID;

  await db.collection("contracts").doc(contractId).set({
    id: contractId,
    orgId,
    customerId,
    contractNumber: "CTR-2025-0001",
    type: "MSA",
    status: "ACTIVE",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log("✅ seeded contract:", contractId, "org:", orgId);
})();
NODE
