#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
CUSTOMER_ID="${4:-cust_acme_001}"
VERSION_ID="${5:-v1}"

# Firestore emulator port (your logs show 8081 right now)
export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8081}"

echo "==> Seeding Firestore emulator"
echo "    PROJECT_ID=$PROJECT_ID"
echo "    FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"
echo "    ORG_ID=$ORG_ID CONTRACT_ID=$CONTRACT_ID CUSTOMER_ID=$CUSTOMER_ID VERSION_ID=$VERSION_ID"

node - <<'NODE'
const admin = require('firebase-admin');

const PROJECT_ID = process.env.PROJECT_ID || 'peakops-pilot';
const ORG_ID = process.env.ORG_ID || 'org_001';
const CONTRACT_ID = process.env.CONTRACT_ID || 'car_abc123';
const CUSTOMER_ID = process.env.CUSTOMER_ID || 'cust_acme_001';
const VERSION_ID = process.env.VERSION_ID || 'v1';

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

(async () => {
  // Contract doc
  await db.collection('contracts').doc(CONTRACT_ID).set({
    orgId: ORG_ID,
    orgid: ORG_ID, // keep both while UI expects either
    customerId: CUSTOMER_ID,
    contractNumber: 'CTR-2025-0001',
    status: 'ACTIVE',
    type: 'MSA',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Payload docs under contracts/{id}/payloads/{payloadDocId}
  const payloads = [
    ['BABA', 'baba.v1', `${VERSION_ID}_baba`],
    ['DIRS', 'dirs.v1', `${VERSION_ID}_dirs`],
    ['NORS', 'nors.v1', `${VERSION_ID}_nors`],
    ['OE_417', 'oe_417.v1', `${VERSION_ID}_oe_417`],
    ['SAR',  'sar.v1',  `${VERSION_ID}_sar`],
  ];

  for (const [type, schemaVersion, docId] of payloads) {
    await db.collection('contracts').doc(CONTRACT_ID)
      .collection('payloads').doc(docId)
      .set({
        versionId: VERSION_ID,
        schemaVersion,
        createdBy: 'seed',
        payload: { _placeholder: 'INIT' },
        contractId: CONTRACT_ID,
        type,
        orgId: ORG_ID,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  console.log(`✅ seeded emulator:
  contracts/${CONTRACT_ID}
  contracts/${CONTRACT_ID}/payloads (5 docs)`);
})();
NODE

echo "==> Smoke via emulator functions"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/${PROJECT_ID}/us-central1}"
curl -sS "$FN_BASE/hello" | head -c 120; echo
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 220; echo
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | head -c 220; echo

echo
echo "✅ UI should work now:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
