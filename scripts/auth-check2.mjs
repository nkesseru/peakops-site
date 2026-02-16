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
  const org = "peakops-telecom-pilot";
  const flagsSnap = await db.collection("organizations").doc(org).collection("flags").limit(5).get();
  console.log("Found flags:", flagsSnap.size);
  flagsSnap.forEach(doc => console.log(doc.id, doc.data()));
})();
