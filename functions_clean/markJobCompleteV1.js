const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.markJobCompleteV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: marking a job complete is field-or-above.
    // Migrated off jobAuthz.js (which carried emulator-bypass
    // semantics that violate the no-bypass invariant). The new gate
    // requires the caller to be an active member of the orgId they
    // claim. The cross-org partner pathway (a contractor whose org
    // has the job assigned to them) is preserved by the explicit
    // resource-integrity check below: caller's orgId must be either
    // the incident-owner OR the job's assigned partner.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[markJobCompleteV1] authz_denied", {
        fn: "markJobCompleteV1",
        orgId,
        incidentId,
        jobId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[markJobCompleteV1] authz_ok", {
      fn: "markJobCompleteV1",
      orgId,
      incidentId,
      jobId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const db = getFirestore();

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });
    const incident = incSnap.data() || {};
    if (String(incident.status || "").toLowerCase() === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed" });
    }

    const jobRef = incRef.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    const incidentOrgId = String(incident.orgId || "").trim();
    const assignedOrgId = String(job.assignedOrgId || "").trim();
    if (!assignedOrgId) {
      return j(res, 403, { ok: false, error: "assigned_org_required" });
    }

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Caller's claimed orgId must be either the incident owner or
    // the job's assigned partner. Replaces jobAuthz's
    // requireOrgMember(assignedOrgId, ...) cross-org check, but
    // without the emulator-bypass.
    const _isIncidentOwner = incidentOrgId && incidentOrgId === orgId;
    const _isAssignedPartner = assignedOrgId === orgId;
    if (!_isIncidentOwner && !_isAssignedPartner) {
      console.warn("[markJobCompleteV1] org_not_party_to_job", {
        orgId, incidentOrgId, assignedOrgId, uid: actorUid,
      });
      return j(res, 403, { ok: false, error: "org_not_party_to_job" });
    }

    const prev = String(job.status || "open").toLowerCase();
    if (prev === "complete") {
      return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "complete", already: true });
    }
    if (!["open", "assigned", "in_progress"].includes(prev)) {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `${prev} -> complete not allowed` });
    }

    await jobRef.set(
      {
        status: "complete",
        reviewStatus: "none",
        completedAt: FieldValue.serverTimestamp(),
        completedBy: {
          uid: actorUid,
          // email used to come from jobAuthz's resolveActor; the
          // _authz.js path doesn't surface it, and we'd rather not
          // re-introduce a body-trusted email field. The audit log
          // already carries uid + role; downstream surfaces that
          // need email can resolve it from users/{uid}.
          email: "",
          orgId,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await emitTimelineEvent({
      orgId: String(incident.orgId || orgId),
      incidentId,
      type: "job_completed",
      refId: jobId,
      actor: "field",
      meta: { from: prev, to: "complete", assignedOrgId },
    });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "complete" });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
