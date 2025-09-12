// scripts/seed-staged-jobs.mjs — create one job per stage for quick UI testing
import admin from "firebase-admin";
import fs from "node:fs";

const sa = JSON.parse(fs.readFileSync("./sa.json","utf8"));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });

const db = admin.firestore();
const sv = admin.firestore.FieldValue;
const ts = admin.firestore.Timestamp;
const now = () => ts.now();

const [,, ORG = "peakops-telecom-pilot"] = process.argv;
const siteId = "SEED-SITE-001";

const stages = [
  { id: "SEED_DRAFT",          status: "draft",           siteName: "Seed Site – Draft" },
  { id: "SEED_SCHEDULED",      status: "scheduled",       siteName: "Seed Site – Scheduled" },
  { id: "SEED_IN_PROGRESS",    status: "in_progress",     siteName: "Seed Site – In Progress" },
  { id: "SEED_CLOSEOUT_READY", status: "closeout_ready",  siteName: "Seed Site – Closeout" },
  { id: "SEED_DONE",           status: "done",            siteName: "Seed Site – Done" },
];

(async () => {
  const orgRef = db.collection("organizations").doc(ORG);

  // ensure a site exists
  await orgRef.collection("sites").doc(siteId).set({
    id: siteId,
    orgId: ORG,
    name: "Seed Site",
    region: "North",
    address: { city: "Spokane Valley", state: "WA" },
    createdAt: sv.serverTimestamp(),
    updatedAt: sv.serverTimestamp(),
  }, { merge: true });

  // create each job (without array timestamps)
  const batch = db.batch();
  for (const s of stages) {
    const doc = {
      id: s.id,
      orgId: ORG,
      siteId,
      siteName: s.siteName,
      customerName: "Demo Customer",
      workType: "Tower PM",
      priority: "normal",
      status: s.status,
      schedule: { targetStart: now(), targetDue: now() },
      materialsReady: true,
      prerequisitesMet: true,
      isReady: true,
      createdAt: sv.serverTimestamp(),
      updatedAt: sv.serverTimestamp(),
    };
    batch.set(orgRef.collection("jobs").doc(s.id), doc, { merge: true });
  }
  await batch.commit();

  // second pass: push statusHistory entries with concrete timestamp (allowed in arrays)
  for (const s of stages) {
    await orgRef.collection("jobs").doc(s.id).update({
      statusHistory: sv.arrayUnion({ key: s.status, at: now(), by: "seed" })
    });
  }

  console.log(`✅ Seeded staged jobs for org: ${ORG}`);
})().catch(e => { console.error("❌ Seed error:", e?.message || e); process.exit(1); });
