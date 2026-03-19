import admin from "firebase-admin";
import fs from "node:fs";

const sa = JSON.parse(fs.readFileSync("./sa.json","utf8"));
const useAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: useAdc ? admin.credential.applicationDefault() : admin.credential.cert(sa),
    projectId: sa.project_id
  });
}
const db = admin.firestore();

const [,, ORG, JOB, NEXT] = process.argv;
if (!ORG || !JOB || !NEXT) {
  console.error("Usage: node scripts/advance-stage.mjs <ORG_ID> <JOB_ID> <draft|scheduled|in_progress|closeout_ready|done>");
  process.exit(1);
}

await db.collection("organizations").doc(ORG).collection("jobs").doc(JOB)
  .set({ status: NEXT, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

console.log(`✅ advanced ${JOB} → ${NEXT}`);
