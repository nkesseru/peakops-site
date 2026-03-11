require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.createJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const title = mustStr(body.title || body.jobTitle || body.name, "title");
    const actorUid = String(body.actorUid || body.actorId || body.techUserId || body.createdBy || "dev").trim();

    const db = getFirestore();

    // ✅ Must match listJobsV1/getJobV1
    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc();

    const now = FieldValue.serverTimestamp();
    await ref.set({
      id: ref.id,
      incidentId,
      orgId,            // important for org checks
      assignedOrgId: orgId,
      title,
      status: "open",
      createdAt: now,
      updatedAt: now,
      createdBy: actorUid,
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, jobId: ref.id, id: ref.id, title, status: "open" });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
