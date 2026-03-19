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

(async () => {
  const org = "peakops-telecom-pilot";  // change if needed
  const jobsSnap = await db.collection("organizations").doc(org).collection("jobs").limit(5).get();
  console.log("Found jobs:", jobsSnap.size);
  jobsSnap.forEach(doc => console.log(doc.id, doc.data().status));
})();
