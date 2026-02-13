const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.getEvidenceDebugV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });

    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
    const snap = await getEvidenceCollectionRef(admin.firestore(), incidentId)
      .orderBy("storedAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs
      .map((d) => {
        const data = d.data() || {};
        if (String(data.orgId || "") !== orgId) return null;
        return {
          id: d.id,
          storagePath: data?.file?.storagePath || null,
          contentType: data?.file?.contentType || null,
          previewPath: data?.file?.previewPath || null,
          thumbPath: data?.file?.thumbPath || null,
        };
      })
      .filter(Boolean);

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      collectionPath: `incidents/${incidentId}/evidence_locker`,
      count: docs.length,
      docs,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
