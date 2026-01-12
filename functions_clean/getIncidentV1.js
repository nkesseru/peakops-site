const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return send(res, 404, { ok: false, error: "Incident not found" });

    const doc = { id: snap.id, ...snap.data() };
    return send(res, 200, { ok: true, orgId, incidentId, doc });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
