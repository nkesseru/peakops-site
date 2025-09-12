
import admin from "firebase-admin";
import fs from "node:fs";

const sa = JSON.parse(fs.readFileSync("./sa.json","utf8"));  // local file, do not commit
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
}
const db = admin.firestore();

const [,, ORG] = process.argv;
const now = admin.firestore.Timestamp.now();

const doc = {
  status: "scheduled",
  customerName: "AT&T",
  siteId: "demoSite",
  siteName: "Tower 12A",
  workType: "Tower PM",
  priority: "high",
  scope: "Routine PM",
  scheduledStart: now,
  scheduledEnd: now,
  materialsReady: true,
  prerequisitesMet: true,
  isReady: true,
  assigneeIds: ["u-eric"],
  crewId: "crew-alpha",
  createdBy: "seed",
  createdAt: now,
  updatedAt: now,
  statusHistory: [{ key:"scheduled", at: now, by: "seed" }]
};

const ref = await db.collection("organizations").doc(ORG).collection("jobs").add(doc);
console.log("✅ new job", ref.id);
