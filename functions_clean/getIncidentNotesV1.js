const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

// GET /getIncidentNotesV1?orgId=...&incidentId=...
exports.getIncidentNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");

    const ref = db.doc(`orgs/${orgId}/incidents/${incidentId}/notes/main`);
    const snap = await ref.get();

    if (!snap.exists) return j(res, 200, { ok: true, orgId, incidentId, notes: { incidentNotes: "", siteNotes: "" } });

    return j(res, 200, { ok: true, orgId, incidentId, notes: snap.data() || {} });
  } catch (e) {
    console.error("getIncidentNotesV1 error", e);
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
