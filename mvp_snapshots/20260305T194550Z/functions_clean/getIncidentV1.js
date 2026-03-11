const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function isDemoBypass(req) {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" &&
    String(req.get?.("x-peakops-demo") || "") === "1";
}

exports.getIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return send(res, 404, { ok: false, error: "Incident not found" });

    const data = snap.data() || {};
    const incOrgId = String(data.orgId || "").trim();
    if (!isDemoBypass(req) && incOrgId && incOrgId !== orgId) {
      return send(res, 409, { ok: false, error: "org_mismatch" });
    }

    const doc = { id: snap.id, ...data };
    return send(res, 200, { ok: true, orgId, incidentId, doc });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
