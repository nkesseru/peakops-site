const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

async function assertIncidentOrg(db, orgId, incidentId) {
  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("incident_not_found");
  const inc = incSnap.data() || {};
  const incOrgId = String(inc.orgId || "").trim();
  if (incOrgId && incOrgId !== orgId) throw new Error("org_mismatch");
}

// GET ?orgId&incidentId&limit
exports.listJobsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    if (!orgId || !incidentId) return j(res, 400, { ok: false, error: "orgId and incidentId required" });

    const db = getFirestore();
    await assertIncidentOrg(db, orgId, incidentId);

    const snap = await db
      .collection("incidents")
      .doc(incidentId)
      .collection("jobs")
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return j(res, 200, { ok: true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e), count: 0, docs: [] });
  }
});

