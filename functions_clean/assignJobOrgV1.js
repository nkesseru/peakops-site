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
function isLocked(job) {
  const st = String(job?.status || "").toLowerCase();
  return !!job?.locked || st === "approved";
}

exports.assignJobOrgV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
    const assignedOrgId = mustStr(body.assignedOrgId || body.targetOrgId, "assignedOrgId");
    const actorUid = String(body.actorUid || body.actorId || "dev").trim() || "dev";

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return j(res, 404, { ok: false, error: "job_not_found" });

    const job = snap.data() || {};
    // Lock enforcement
    if (isLocked(job)) return j(res, 409, { ok: false, error: "job_locked" });

    await ref.set({
      orgId,
      incidentId,
      assignedOrgId,
      assignedOrgUpdatedAt: FieldValue.serverTimestamp(),
      assignedOrgUpdatedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Timeline event
    await db.collection("incidents").doc(incidentId).collection("timeline_events")
      .doc(`job_assigned_org_${jobId}_${Date.now()}`)
      .set({
        id: `job_assigned_org_${jobId}_${Date.now()}`,
        type: "JOB_ASSIGNED_ORG",
        orgId,
        incidentId,
        jobId,
        assignedOrgId,
        actorUid,
        occurredAt: FieldValue.serverTimestamp(),
      }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, assignedOrgId });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
