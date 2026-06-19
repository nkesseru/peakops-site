const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
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

function linkedJobId(ev) {
  return String(ev?.jobId || ev?.evidence?.jobId || "").trim();
}

// PEAKOPS_AUTHZ_LEGACY_RETIRE_V1 (2026-05-06)
// Slice 7: removed assertViewAccess + isEmulatorRuntime. They were
// the last call sites in getJobV1 routing through jobAuthz.js's
// requireOrgMember, which carried emulator-bypass semantics that
// the architecture model's "no demo bypass" invariant explicitly
// forbids. The work the helper did has been replaced inline by
// (a) the Slice 6 top-of-handler assertActorCanReadOrg gate
// (already present), and (b) the resource-integrity check below
// that the caller's claimed orgId equals incidentOrgId or
// assignedOrgId.

exports.getJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });
    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");
    const jobId = mustStr(req.query.jobId, "jobId");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: top-of-handler members-only gate. Defense in
    // depth — the existing assertViewAccess below still enforces the
    // cross-org assignedOrgId branch (so a partner org member with a
    // job assigned to them keeps working), and the legacy jobAuthz
    // path stays in place for now. The new gate ensures a caller who
    // claims `orgId=X` actually holds active membership in X before
    // any incident/job/evidence read runs.
    let _readActorUid = "";
    let _readActorRole = null;
    try {
      ({ uid: _readActorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, _readActorUid);
      _readActorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getJobV1] authz_denied", {
        fn: "getJobV1",
        orgId,
        incidentId,
        jobId,
        uid: _readActorUid,
        role: (e && e.details && e.details.role) || null,
        capability: "read",
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[getJobV1] authz_ok", {
      fn: "getJobV1",
      orgId,
      incidentId,
      jobId,
      uid: _readActorUid,
      role: _readActorRole,
      capability: "read",
    });

    const db = getFirestore();

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });
    const incident = incSnap.data() || {};
    const incidentOrgId = String(incident.orgId || "").trim();
    if (!incidentOrgId) return j(res, 400, { ok: false, error: "incident_org_missing" });

    const jobRef = incRef.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    if (String(job.incidentId || incidentId) !== incidentId) return j(res, 409, { ok: false, error: "incident_mismatch" });

    const assignedOrgId = String(job.assignedOrgId || "").trim();

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Slice 7 replacement for assertViewAccess. The Slice 6 top-of-
    // handler gate already verified the caller is an active member
    // of orgId. Now verify the *resource* matches the claim: the
    // claimed orgId must be either the incident owner OR the job's
    // assigned partner. No emulator bypass.
    const _isIncidentOwner = incidentOrgId === orgId;
    const _isAssignedPartner = !!assignedOrgId && assignedOrgId === orgId;
    if (!_isIncidentOwner && !_isAssignedPartner) {
      console.warn("[getJobV1] org_not_party_to_job", {
        orgId, incidentOrgId, assignedOrgId, uid: _readActorUid,
      });
      return j(res, 403, { ok: false, error: "org_not_party_to_job" });
    }
    const access = _isIncidentOwner ? "incident_owner" : "assigned_partner";

    const evSnap = await incRef.collection("evidence_locker").limit(limit).get();
    const evidence = evSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((ev) => linkedJobId(ev) === jobId);

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      jobId,
      access,
      job: { id: jobSnap.id, ...job },
      incident: {
        id: incidentId,
        orgId: incidentOrgId,
        title: String(incident.title || incident.incidentId || incidentId),
        status: String(incident.status || "open"),
      },
      evidenceCount: evidence.length,
      evidence,
    });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
