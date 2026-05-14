// Read-only delta checker for the saveIncidentNotesV1 smoke test.
// Usage: ORG=... INC=... node checkNotesTimelineDelta.cjs
// Prints canonical + mirror counts at both the timeline_events
// subcollection AND the notes/main doc, and any NOTES_SAVED events
// written today. Phase 4 (2026-05-14) added the notes/main checks
// because the production canonical write path is top-level
// `incidents/{incidentId}/notes/main`, not `orgs/{orgId}/...`.
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

const orgId = process.env.ORG;
const incidentId = process.env.INC;
if (!orgId || !incidentId) {
  console.error("ORG and INC required");
  process.exit(2);
}

function fmt(ts) {
  if (!ts) return "-";
  if (ts.toDate) return ts.toDate().toISOString();
  if (ts._seconds) return new Date(ts._seconds * 1000).toISOString();
  return String(ts);
}

(async () => {
  const canonicalCol = db.collection(`incidents/${incidentId}/timeline_events`);
  const mirrorCol = db.collection(`orgs/${orgId}/incidents/${incidentId}/timeline_events`);

  const [cCount, mCount] = await Promise.all([
    canonicalCol.count().get(),
    mirrorCol.count().get(),
  ]);

  console.log(`incident: ${incidentId}`);
  console.log(`org:      ${orgId}`);
  console.log(`canonical (incidents/${incidentId}/timeline_events): ${cCount.data().count}`);
  console.log(`mirror    (orgs/${orgId}/incidents/${incidentId}/timeline_events): ${mCount.data().count}`);
  console.log();

  for (const [label, col] of [["canonical", canonicalCol], ["mirror", mirrorCol]]) {
    const snap = await col.orderBy("occurredAt", "desc").limit(3).get();
    console.log(`── ${label} most-recent 3 ──`);
    if (snap.empty) {
      console.log("  (none)");
    } else {
      for (const d of snap.docs) {
        const v = d.data() || {};
        console.log(`  ${d.id}  type=${v.type}  actor=${v.actor}  occurredAt=${fmt(v.occurredAt)}`);
      }
    }
  }

  console.log();
  console.log("── NOTES_SAVED events at each path ──");
  for (const [label, col] of [["canonical", canonicalCol], ["mirror", mirrorCol]]) {
    const snap = await col.where("type", "==", "NOTES_SAVED").get();
    console.log(`  ${label}: ${snap.size} NOTES_SAVED events`);
    for (const d of snap.docs) {
      const v = d.data() || {};
      console.log(`    ${d.id}  occurredAt=${fmt(v.occurredAt)}  meta=${JSON.stringify(v.meta || {})}`);
    }
  }

  console.log();
  console.log("── notes/main doc presence at each path ──");
  const canonicalNotes = db.doc(`incidents/${incidentId}/notes/main`);
  const mirrorNotes = db.doc(`orgs/${orgId}/incidents/${incidentId}/notes/main`);
  const [cn, mn] = await Promise.all([canonicalNotes.get(), mirrorNotes.get()]);
  for (const [label, snap, path] of [
    ["canonical", cn, `incidents/${incidentId}/notes/main`],
    ["mirror", mn, `orgs/${orgId}/incidents/${incidentId}/notes/main`],
  ]) {
    if (!snap.exists) {
      console.log(`  ${label}: ABSENT  (${path})`);
    } else {
      const d = snap.data() || {};
      const inc = String(d.incidentNotes || "");
      const site = String(d.siteNotes || "");
      console.log(
        `  ${label}: PRESENT  updatedBy=${d.updatedBy}  updatedAt=${fmt(d.updatedAt)}  incidentNotesLen=${inc.length}  siteNotesLen=${site.length}  (${path})`
      );
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
