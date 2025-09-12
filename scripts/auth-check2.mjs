import admin from "firebase-admin";
import fs from "node:fs";

const sa = JSON.parse(fs.readFileSync("./sa.json","utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
}
const db = admin.firestore();

(async () => {
  const org = "peakops-telecom-pilot";
  const flagsSnap = await db.collection("organizations").doc(org).collection("flags").limit(5).get();
  console.log("Found flags:", flagsSnap.size);
  flagsSnap.forEach(doc => console.log(doc.id, doc.data()));
})();
