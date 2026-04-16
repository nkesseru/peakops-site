const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

exports.createIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

  const body = (typeof req.body === "object" && req.body) ? req.body : {};
  const orgId = String(body.orgId || "").trim();
  const incidentId = String(body.incidentId || "").trim();

  if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
  if (!incidentId) return j(res, 400, { ok: false, error: "incidentId required" });

  const title = String(body.title || "").trim();
  const status = String(body.status || "open").trim().toLowerCase();
  const filingTypesRequired = Array.isArray(body.filingTypesRequired) ? body.filingTypesRequired : [];

  const db = getFirestore();
  const ref = db.doc(`orgs/${orgId}/incidents/${incidentId}`);

  try {
    const existing = await ref.get();
    if (existing.exists) {
      return j(res, 409, { ok: false, error: "Incident already exists", orgId, incidentId });
    }

    await ref.set({
      orgId,
      incidentId,
      title,
      status,
      filingTypesRequired,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return j(res, 201, { ok: true, orgId, incidentId });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
