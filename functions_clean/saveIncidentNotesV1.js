const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();
const db = getFirestore();

async function emitTimelineEvent({ orgId, incidentId, type, actor, sessionId, refId, meta }) {
  const col = db.collection(`orgs/${orgId}/incidents/${incidentId}/timeline_events`);
  await col.add({
    orgId,
    incidentId,
    type,
    actor: actor || "ui",
    sessionId: sessionId || null,
    refId: refId || null,
    meta: meta || null,
    v: 1,
    occurredAt: FieldValue.serverTimestamp(),
  });
}


function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

// POST /saveIncidentNotesV1 { orgId, incidentId, incidentNotes, siteNotes, updatedBy }
exports.saveIncidentNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const b = (req.body && typeof req.body === "object") ? req.body : {};
    const orgId = mustStr(b.orgId, "orgId");
    const incidentId = mustStr(b.incidentId, "incidentId");

    const incidentNotes = String(b.incidentNotes || "");
    const siteNotes = String(b.siteNotes || "");
    const updatedBy = String(b.updatedBy || "ui");

    const ref = db.doc(`orgs/${orgId}/incidents/${incidentId}/notes/main`);
    await ref.set(
      {
        incidentNotes,
        siteNotes,
        updatedBy,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

        // Emit audit timeline event
    try {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "NOTES_SAVED",
        actor: updatedBy || "ui",
        sessionId: null,
        refId: null,
        meta: {
          incidentNotesLen: incidentNotes.length,
          siteNotesLen: siteNotes.length,
        },
      });
    } catch (e) {
      console.error("NOTES_SAVED emit failed", e);
    }

return j(res, 200, { ok: true, orgId, incidentId });
  } catch (e) {
    console.error("saveIncidentNotesV1 error", e);
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
