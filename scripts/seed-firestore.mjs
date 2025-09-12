// scripts/seed-firestore.mjs  — admin-based, idempotent, future-proof
import admin from "firebase-admin";
import fs from "node:fs";

// -------- service account (local) --------
const saPath = "./sa.json";
if (!fs.existsSync(saPath)) {
  console.error(`Missing ${saPath}. Put your service account json at project root.`);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
}
const db = admin.firestore();
const sv = admin.firestore.FieldValue;
const ts = admin.firestore.Timestamp;
const now = () => ts.now();

// -------- helpers --------
const nowISO = () => new Date().toISOString();
const rnd = (p = "") => `${p}${Math.random().toString(36).slice(2, 8)}`;
const argOr = (i, d) => (process.argv[i] ? String(process.argv[i]) : d);

// -------- params --------
const orgId = argOr(2, "peakops-telecom-pilot");
const siteId = argOr(3, "WA-CC-88312");
const jobId = argOr(4, "WO-TEST001");

// -------- seed payload --------
const seeds = {
  orgs: [{
    id: orgId, name: "Butler America Telecom — Pilot", status: "active",
    billing: { terms: "NET30", currency: "USD" },
    contacts: { primary: { name: "Chelsea", email: "chelsea@example.com" } },
    preferences: { timezone: "America/Los_Angeles", weekStartsOn: "Mon" }
  }],

  locations: [{
    id: siteId, orgId,
    meta: { title: "Crown Castle — Spokane Valley" },
    address: { line1: "1234 Example Rd", city: "Spokane Valley", state: "WA", zip: "99206", lat: 47.673, lon: -117.239 },
    compliance: { permitsRequired: ["NTP"], JHA: 1 },
    clientIds: { crownCastle: "CC-88312" }, status: "active"
  }],

  users: [
    { id: "nick", orgId, name: "Nicholas Kesseru", email: "nick@peakops.example", roles: ["owner", "admin"], active: true },
    { id: "eric", orgId, name: "Eric Dev",        email: "eric@peakops.example", roles: ["developer"],     active: true }
  ],

  jobs: [{
    id: jobId, orgId, siteId, po: "PRO-12345",
    scope: "Tower audit + photo capture + closeout docs",
    workType: "Tower PM", priority: "high",
    status: "scheduled",
    schedule: { targetStart: now(), targetDue: now() },
    budget: { laborHours: 8, materialsUSD: 150 },
    materialsReady: true, prerequisitesMet: true, isReady: true
  }],

  workOrders: [{
    id: rnd("wo_"), orgId, siteId, jobId, status: "open",
    tasks: [
      { code: "ARRIVE",  title: "Arrival & Site Check-in",   status: "todo" },
      { code: "JHA",     title: "Job Hazard Analysis",       status: "todo" },
      { code: "PHOTOS",  title: "Photo set capture",         status: "todo" },
      { code: "CLOSEOUT",title: "Upload docs & email digest",status: "todo" }
    ]
  }],

  events: [{
    id: rnd("ev_"), orgId, siteId, jobId,
    type: "ingested", source: "email_intake",
    // use concrete ISO at write; serverTimestamp used for 'at' below
    ts: nowISO(), actor: { type: "system", id: "ingestor_01" }
  }],

  fieldForms: [{
    id: rnd("form_"), orgId, siteId, jobId, formKey: "JHA_V1",
    version: 1, submittedAt: nowISO(), submittedBy: "tech_001",
    answers: { PPE: ["Gloves", "Hardhat"], hazards: ["RF", "TRIP"] },
    attachments: [{ s3: "s3://bucket/jha.pdf" }], status: "Complete",
    quality: { score: 0.9, warnings: [] }
  }],

  flags: [{
    id: rnd("flag_"), orgId, siteId, jobId, entityType: "job",
    severity: "yellow", reason: "Missing photo set: azimuth",
    origin: "auto", status: "open"
  }],

  photos: [{
    id: rnd("photo_"), orgId, siteId, jobId,
    storagePath: "gs://peakops/photos/WO-TEST001/azimuth_001.jpg",
    tags: ["azimuth:120", "antenna", "closeout"],
    exif: { ts: nowISO(), device: "iPhone 15 Pro" },
    status: "indexed"
  }],

  tags: [{ id: rnd("tg_"), orgId, label: "global", features: { emailIntake: true, autoFlagging: true } }],

  crews: [{ id: "crew_001", orgId, name: "Northwest Field Team",
    members: [{ userId: "tech_001", role: "tech" }, { userId: "tech_002", role: "rigger" }]
  }]
};

// -------- write logic (batched + array timestamp safe) --------
(async () => {
  const b = db.batch();
  const orgRef = db.collection("organizations").doc(orgId);

  // org
  for (const o of seeds.orgs) {
    b.set(orgRef, { ...o, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }

  // subcollections
  for (const loc of seeds.locations) {
    b.set(orgRef.collection("sites").doc(loc.id), { ...loc, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const u of seeds.users) {
    b.set(orgRef.collection("users").doc(u.id), { ...u, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const j of seeds.jobs) {
    // write job WITHOUT statusHistory first (serverTimestamp safe)
    const jobDoc = { ...j, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() };
    delete jobDoc.statusHistory; // ensure none sneaks in
    b.set(orgRef.collection("jobs").doc(j.id), jobDoc, { merge: true });
  }
  for (const w of seeds.workOrders) {
    b.set(orgRef.collection("work_orders").doc(w.id), { ...w, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const e of seeds.events) {
    // use 'at' as server time for sort; keep e.ts as source ts
    b.set(orgRef.collection("events").doc(e.id), { ...e, at: sv.serverTimestamp() }, { merge: true });
  }
  for (const f of seeds.fieldForms) {
    b.set(orgRef.collection("field_forms").doc(f.id), { ...f, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const fl of seeds.flags) {
    b.set(orgRef.collection("flags").doc(fl.id), { ...fl, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const p of seeds.photos) {
    b.set(orgRef.collection("photos").doc(p.id), { ...p, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const t of seeds.tags) {
    b.set(orgRef.collection("tags").doc(t.id), { ...t, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }
  for (const c of seeds.crews) {
    b.set(orgRef.collection("crews").doc(c.id), { ...c, createdAt: sv.serverTimestamp(), updatedAt: sv.serverTimestamp() }, { merge: true });
  }

  await b.commit();

  // SECOND PASS: push statusHistory entries with concrete Timestamp (allowed in arrays)
  const jobsCol = orgRef.collection("jobs");
  for (const j of seeds.jobs) {
    await jobsCol.doc(j.id).update({
      statusHistory: sv.arrayUnion({ key: j.status, at: now(), by: "seed" })
    });
  }

  console.log(`✅ Seed complete for org: ${orgId} (site ${siteId}, job ${jobId})`);
})().catch((e) => {
  console.error("❌ Seed error:", e?.message || e);
  process.exit(1);
});
