const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

exports.listIncidentsV1 = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });

  const orgId = String(req.query.orgId || "").trim();
  if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });

  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const db = getFirestore();

  try {
    const snap = await db
      .collection(`orgs/${orgId}/incidents`)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();

    const incidents = snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        orgId: String(data.orgId || orgId),
        title: String(data.title || ""),
        status: String(data.status || "open"),
        createdAt: data.createdAt?.toDate?.().toISOString?.() || data.createdAt || null,
        updatedAt: data.updatedAt?.toDate?.().toISOString?.() || data.updatedAt || null,
      };
    });

    return j(res, 200, { ok: true, orgId, count: incidents.length, incidents });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
