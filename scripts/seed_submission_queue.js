// scripts/seed_submission_queue.js

const admin = require("firebase-admin");

// Reuse default app if already initialized somewhere
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function run() {
  const orgId = "butler-pud";
  const incidentId = "BUTLER-PUD_INC-1001"; // match your telecom incident id
  const docId = `${incidentId}`;            // or `${orgId}_${incidentId}` if you prefer

  const docRef = db.collection("submission_queue").doc(docId);

  const now = admin.firestore.FieldValue.serverTimestamp();

  await docRef.set(
    {
      orgId,
      incidentId,
      filingType: "DIRS",         // or "OE417"
      status: "PENDING",          // key for the worker
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      payload: {
        sample: "testing payload",
        note: "seeded via seed_submission_queue.js",
      },
    },
    { merge: true }
  );

  console.log(`Seeded submission_queue/${docId}`);
}

run()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error seeding submission_queue:", err);
    process.exit(1);
  });
