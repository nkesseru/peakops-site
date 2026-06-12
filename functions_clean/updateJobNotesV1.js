const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
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

exports.updateJobNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
    const notes = String(body.notes || "").slice(0, 4000);

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: updating job notes is field-or-above.
    // Migrated off jobAuthz.js (whose assertNotesAccess required
    // owner/admin on the incident-owner side and used emulator-
    // bypass semantics). The new policy: any active member of the
    // claimed orgId may update notes, AND the claimed orgId must be
    // either the incident owner or the job's assigned partner.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[updateJobNotesV1] authz_denied", {
        fn: "updateJobNotesV1",
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
    console.log("[updateJobNotesV1] authz_ok", {
      fn: "updateJobNotesV1",
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
    const incidentOrgId = String(incident.orgId || "").trim();
    if (String(incident.status || "").toLowerCase() === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed" });
    }

    const jobRef = incRef.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    const assignedOrgId = String(job.assignedOrgId || "").trim();

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Caller's claimed orgId must be either the incident owner or
    // the job's assigned partner. Replaces jobAuthz's
    // assertNotesAccess cross-org check, without the bypass.
    const _isIncidentOwner = incidentOrgId && incidentOrgId === orgId;
    const _isAssignedPartner = assignedOrgId && assignedOrgId === orgId;
    if (!_isIncidentOwner && !_isAssignedPartner) {
      console.warn("[updateJobNotesV1] org_not_party_to_job", {
        orgId, incidentOrgId, assignedOrgId, uid: actorUid,
      });
      return j(res, 403, { ok: false, error: "org_not_party_to_job" });
    }

    await jobRef.set(
      {
        notes,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return j(res, 200, { ok: true, orgId, incidentId, jobId, notes });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
