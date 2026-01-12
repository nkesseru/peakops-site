const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getTimelineEventsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);

    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incRef = db.collection("incidents").doc(incidentId);

    // Optional: check org match if the doc exists
    const incSnap = await incRef.get();
    if (incSnap.exists) {
      const data = incSnap.data() || {};
      if (data.orgId && String(data.orgId) !== orgId) {
        return send(res, 404, { ok: false, error: "Incident not found" });
      }
    }

    // Pull timelineEvents subcollection if present
    let q = incRef.collection("timelineEvents").orderBy("occurredAt", "asc").limit(limit);
    const snap = await q.get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      count: docs.length,
      docs,
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
