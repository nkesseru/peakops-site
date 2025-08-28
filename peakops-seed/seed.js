// Seed Phase-1 Firestore schema for PeakOps (Telecom)
// Usage:
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
//   export ORG_ID=butler_pilot
//   node seed.js

import admin from "firebase-admin";

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.");
  process.exit(1);
}
if (!process.env.ORG_ID) {
  console.error("Set ORG_ID to your pilot org id (e.g., butler_pilot).");
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();
const orgId = process.env.ORG_ID;

// util
const now = () => admin.firestore.Timestamp.now();

async function ensureDoc(path, data) {
  const ref = db.doc(path);
  const snap = await ref.get();
  if (!snap.exists) await ref.set(data, { merge: true });
  return ref;
}

async function run() {
  console.log(`Seeding Firestore for orgId='${orgId}'`);

  // 1) orgs
  const orgRef = await ensureDoc(`orgs/${orgId}`, {
    orgId,
    name: "Butler Pilot",
    slug: "butler",
    plan: "pilot",
    isActive: true,
    createdAt: now(),
    appSettings: {
      timezone: "America/Los_Angeles",
      currency: "USD"
    }
  });

  // 2) users (create your admin shell; update uid to your real auth uid later)
  const adminUid = "admin_placeholder_uid";
  await ensureDoc(`users/${adminUid}`, {
    orgId,
    email: "nick@example.com",
    displayName: "Nick (Admin)",
    role: "admin",                 // admin | dispatcher | tech | viewer
    status: "active",
    createdAt: now()
  });

  // 3) locations
  const locationRef = db.collection("locations").doc();
  await ensureDoc(locationRef.path, {
    orgId,
    customerName: "Butler HQ",
    siteName: "Main Campus",
    address: { line1: "123 Main St", city: "Spokane Valley", state: "WA", zip: "99037" },
    geo: { lat: 47.673, lng: -117.239 },
    primaryContact: { name: "Ops Desk", phone: "+1-555-0100", email: "ops@butler.test" },
    active: true,
    createdAt: now()
  });

  // 4) workOrders (core object)
  const woRef = db.collection("workOrders").doc();
  await ensureDoc(woRef.path, {
    orgId,
    locationId: locationRef.id,
    title: "Install – Fiber drop, Bldg A",
    type: "install",                // install | service | survey | emergency
    priority: "normal",             // low | normal | high | urgent
    status: "new",                  // new | scheduled | in_progress | complete | closed | canceled
    scheduledAt: now(),
    scheduledEnd: now(),
    assignees: [],                  // userId[]
    checklistTemplateId: null,
    budgetMin: 2,                   // hours
    budgetMax: 6,
    poNumber: "PO-0001",
    notes: "Customer prefers morning slot.",
    createdBy: adminUid,
    createdAt: now()
  });

  // 5) tasks (subcollection under workOrder)
  const tasksCol = woRef.collection("tasks");
  await tasksCol.add({
    orgId,
    workOrderId: woRef.id,
    title: "Site check-in",
    required: true,
    status: "open",                 // open | done | na
    sort: 1
  });
  await tasksCol.add({
    orgId,
    workOrderId: woRef.id,
    title: "Run drop & terminate",
    required: true,
    status: "open",
    sort: 2
  });

  // 6) fieldForms
  const formRef = db.collection("fieldForms").doc();
  await ensureDoc(formRef.path, {
    orgId,
    workOrderId: woRef.id,
    locationId: locationRef.id,
    submittedBy: adminUid,
    submittedAt: now(),
    formType: "site_survey",        // before_after | install_report | service_report | site_survey | handoff
    answers: {
      accessGranted: true,
      hazards: "None observed",
      notes: "Good ceiling access"
    },
    score: null,
    flags: []                       // flag ids or inline notes
  });

  // 7) photos (metadata only; file goes to Storage)
  const photoRef = db.collection("photos").doc();
  await ensureDoc(photoRef.path, {
    orgId,
    workOrderId: woRef.id,
    locationId: locationRef.id,
    formId: formRef.id,
    url: "gs://your-bucket/orgs/${orgId}/workOrders/" + woRef.id + "/photos/placeholder.jpg",
    path: `orgs/${orgId}/workOrders/${woRef.id}/photos/placeholder.jpg`,
    label: "Before – closet",
    takenAt: now(),
    uploadedBy: adminUid,
    tags: ["before"]
  });

  // 8) events (audit)
  await db.collection("events").add({
    orgId,
    entity: "workOrder",            // workOrder | task | form | photo | user | location
    entityId: woRef.id,
    type: "create",                 // create | update | status_change | assign | flag | comment
    actorId: adminUid,
    at: now(),
    diff: { status: { from: null, to: "new" } },
    note: "WO created via seed"
  });

  // 9) flags (issue tracker)
  await db.collection("flags").add({
    orgId,
    source: "manual",               // form | task | manual
    workOrderId: woRef.id,
    locationId: locationRef.id,
    severity: "yellow",             // green | yellow | red
    title: "Ceiling tile fragile",
    detail: "Choose alternate route if possible",
    status: "open",                 // open | resolved | ignored
    createdBy: adminUid,
    createdAt: now()
  });

  // 10) settings/security (already created in your case, but ensure present)
  await ensureDoc("settings/security", {
    allowSchemaValidation: true,
    lastTouchedAt: now()
  });

  console.log("✅ Seed complete.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
