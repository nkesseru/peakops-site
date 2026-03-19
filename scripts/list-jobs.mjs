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

const [,, ORG] = process.argv;
if (!ORG) { console.error("Usage: node scripts/list-jobs.mjs <ORG_ID>"); process.exit(1); }

const snap = await db.collection("organizations").doc(ORG).collection("jobs").limit(20).get();
if (snap.empty) { console.log("No jobs found"); process.exit(0); }
snap.forEach(d => console.log(d.id, d.data().status, d.data().siteName || d.data().customerName || ""));
