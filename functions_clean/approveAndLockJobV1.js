require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_APPROVE,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { resolveIncidentRef } = require("./_incidentPath");

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

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: approve+lock is admin-or-supervisor only.
    // Upgraded from the Slice 3 membership gate to a role allow-list.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_APPROVE);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[approveAndLockJobV1] authz_denied", {
        fn: "approveAndLockJobV1",
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
    console.log("[approveAndLockJobV1] authz_ok", {
      fn: "approveAndLockJobV1",
      orgId,
      incidentId,
      jobId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_APPROVE,
    });

    const db = getFirestore();

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Phase 1 Slice 4 Task 3: previously this function wrote a job
    // doc with merge:true even when the parent incident did not exist
    // (live smoke against `inc_smoke_addev_1` returned 200 against a
    // non-existent incident). That's a write-amplification bug — a
    // valid member could create orphan job docs under arbitrary
    // incident ids. Mirror the same existence + orgId-match check
    // that approveJobV1 has used for a while.
    const { ref: incRef } = await resolveIncidentRef(orgId, incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) {
      return j(res, 404, { ok: false, error: "incident_not_found" });
    }
    const incOrgId = String((incSnap.data() || {}).orgId || "").trim();
    if (incOrgId && incOrgId !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }

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

    await emitTimelineEvent({
      orgId,
      incidentId,
      type: "job_approved",
      refId: jobId,
      actor: actorUid,
      meta: { locked: true },
    });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved", locked: true });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
