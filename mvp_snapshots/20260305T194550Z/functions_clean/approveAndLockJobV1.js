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

exports.approveAndLockJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
    const actorUid = String(body.actorUid || body.actorId || "dev").trim() || "dev";

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);

    await ref.set({
      orgId,
      assignedOrgId: orgId,
      status: "approved",
      reviewStatus: "approved",
      locked: true,
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await db.collection("incidents").doc(incidentId).collection("timeline_events").doc(`job_approved_${jobId}`).set({
      id: `job_approved_${jobId}`,
      type: "JOB_APPROVED",
      jobId,
      orgId,
      actorUid,
      occurredAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved", locked: true });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
