// scripts/seed_submission_queue.cjs

const admin = require("firebase-admin");
const serviceAccount = require("../serviceAccount.json"); // <-- adjust name if needed

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function run() {
  const orgId = "butler-pud";
  const incidentId = "BUTLER-PUD_INC-1001"; // should match your telecom incident
  const docId = `${orgId}_${incidentId}_DIRS`; // queue doc id
  
  const now = admin.firestore.FieldValue.serverTimestamp();
  
  const data = {
    orgId,
    incidentId,
    filingType: "DIRS",      // or "OE417" later  
    status: "PENDING",       // key for the worker
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    payload: {
      sample: "testing payload",
      note: "seeded via seed_submission_queue.cjs",
    },
  };
  
  await db.collection("submission_queue").doc(docId).set(data, { merge: true });
  
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
