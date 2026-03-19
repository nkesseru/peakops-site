#!/usr/bin/env node

const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'service-account.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'peakops-pilot',
  });
}

const db = admin.firestore();

async function run() {
  const now = admin.firestore.Timestamp.now();

  const docs = [];

  for (let i = 1; i <= 5; i++) {
    docs.push({
      orgId: 'demo-org',
      source: 'DIRS',
      payload: {
        ticketId: `INC-SEED-${String(i).padStart(3, '0')}`,
        note: `Seeded test DIRS submission #${i}`,
      },
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    });
  }

  const batch = db.batch();
  const col = db.collection('submission_queue');

  docs.forEach((doc) => {
    const ref = col.doc(); // auto ID
    batch.set(ref, doc);
  });

  await batch.commit();
  console.log(`Seeded ${docs.length} submission_queue docs.`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to seed submission_queue:', err);
    process.exit(1);
  });
