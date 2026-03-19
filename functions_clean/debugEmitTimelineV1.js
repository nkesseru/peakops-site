const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

exports.debugEmitTimelineV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return j(res, 400, { ok:false, error:"Missing orgId/incidentId" });

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId).collection("timeline_events").doc();

    await ref.set({
      orgId,
      incidentId,
      type: "DEBUG_EVENT",
      occurredAt: FieldValue.serverTimestamp(),
      meta: { note: "debug emit" },
      v: 1
    });

    return j(res, 200, { ok:true, id: ref.id });
  } catch (e) {
    return j(res, 500, { ok:false, error:String(e?.message || e) });
  }
});
