import admin from "firebase-admin";
admin.initializeApp();
const db = admin.firestore();

async function run() {
  const orgId = process.env.ORG_ID || "demo-org";
  console.log(`# Listing incidents for orgId=${orgId}\n`);

  // Top-level incidents
  const topQ = await db.collection("incidents").where("orgId", "==", orgId).limit(50).get();
  console.log(`# Top-level incidents/{id} where orgId=${orgId}: ${topQ.size}`);
  for (const d of topQ.docs) {
    const data = d.data() || {};
    const jobsSnap = await db.collection("incidents").doc(d.id).collection("jobs").limit(20).get();
    const tlSnap = await db.collection("incidents").doc(d.id).collection("timeline_events").limit(50).get();
    console.log(JSON.stringify({
      id: d.id,
      title: data.title || null,
      status: data.status || null,
      location: data.location || null,
      jobType: data.jobType || null,
      createdBy: data.createdBy || null,
      createdAt: data.createdAt?._seconds ? new Date(data.createdAt._seconds*1000).toISOString() : null,
      jobs: jobsSnap.size,
      timeline: tlSnap.size,
      jobTitles: jobsSnap.docs.map((j) => (j.data() || {}).title || j.id),
    }));
  }

  // Per-org subcollection (legacy path)
  const subQ = await db.collection("orgs").doc(orgId).collection("incidents").limit(50).get();
  console.log(`\n# Per-org orgs/${orgId}/incidents: ${subQ.size}`);
  for (const d of subQ.docs) {
    const data = d.data() || {};
    console.log(JSON.stringify({
      id: d.id,
      title: data.title || null,
      status: data.status || null,
    }));
  }

  // Members
  const memQ = await db.collection("orgs").doc(orgId).collection("members").limit(50).get();
  console.log(`\n# Members orgs/${orgId}/members: ${memQ.size}`);
  for (const d of memQ.docs) {
    const data = d.data() || {};
    console.log(JSON.stringify({ id: d.id, role: data.role, status: data.status, displayName: data.displayName, email: data.email }));
  }

  // Vendors
  const venQ = await db.collection("orgs").doc(orgId).collection("vendors").limit(50).get();
  console.log(`\n# Vendors orgs/${orgId}/vendors: ${venQ.size}`);
  for (const d of venQ.docs) {
    const data = d.data() || {};
    console.log(JSON.stringify({ id: d.id, name: data.name, status: data.status, contactName: data.contactName }));
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
