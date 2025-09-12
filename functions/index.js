import * as functions from "firebase-functions";
import admin from "firebase-admin";
if (admin.apps.length === 0) admin.initializeApp();

export const onJobWrite = functions.firestore
  .document("organizations/{orgId}/jobs/{jobId}")
  .onWrite(async (change, ctx) => {
    const { orgId, jobId } = ctx.params;
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists ? change.after.data()  : null;
    if (!after) return;

    const batch = admin.firestore().batch();
    const jobRef = change.after.ref;

    // Derive isReady from materials/prereqs
    const derived = !!after.materialsReady && !!after.prerequisitesMet;
    if (after.isReady !== derived) {
      batch.update(jobRef, { isReady: derived });
    }

    // Status history & events
    if (!before || before.status !== after.status) {
      const entry = {
        key: after.status,
        at: admin.firestore.FieldValue.serverTimestamp(),
        by: after.updatedBy ?? after.createdBy ?? null
      };
      batch.update(jobRef, {
        statusHistory: admin.firestore.FieldValue.arrayUnion(entry)
      });
      const eventsRef = admin.firestore()
        .collection(`organizations/${orgId}/job_events`).doc();
      batch.set(eventsRef, {
        jobId, action: "status_change",
        from: before ? before.status : null,
        to: after.status,
        at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();
  });
