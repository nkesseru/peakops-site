require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_APPROVE,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

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

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 5: assigning the org-owner of a job is an
    // admin-or-supervisor action. Upgraded from the Slice 2
    // membership-only gate. Field crews execute work but do not
    // re-assign job ownership — that's a dispatch decision.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_APPROVE);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[assignJobOrgV1] authz_denied", {
        fn: "assignJobOrgV1",
        orgId,
        incidentId,
        jobId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_APPROVE,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[assignJobOrgV1] authz_ok", {
      fn: "assignJobOrgV1",
      orgId,
      incidentId,
      jobId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_APPROVE,
    });

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
