// PEAKOPS_ASSIGN_VENDOR_TO_JOB_V1 (2026-05-06)
//
// Phase 1 Slice 9: replaces the direct-client setDoc that
// next-app/lib/jobVendor.ts performed on
// incidents/{incidentId}/jobs/{jobId}. The Slice 8 firestore.rules
// allowed that write narrowly (supervisor/admin, only the
// {vendorId, vendorName, updatedAt} keys). This callable owns the
// write end-to-end and lets the rules layer drop that narrow
// allowance — every lifecycle write now routes through _authz.js.
//
// Allow-list: ROLES_APPROVE (owner/admin/supervisor). Field crews
// execute work, supervisors dispatch — vendor assignment is a
// dispatch decision.
//
// Resource integrity:
//   - incident must exist (canonical or legacy path)
//   - incident.orgId must match body.orgId when present
//   - job must exist under the incident
//   - job.orgId must match body.orgId when present
//   - if assigning (vendorId non-empty), the vendor must exist under
//     orgs/{orgId}/vendors/{vendorId} and not be archived
//
// Mutation: only {vendorId, vendorName, updatedAt, updatedBy} on the
// job doc, with merge:true. Same shape the prior client write used.
// On assign, vendorName is the canonical vendor.name from the vendor
// doc — body.vendorName is treated as a hint and overridden if the
// vendor doc has a name field. On clear (vendorId empty/null), both
// vendorId and vendorName are nulled.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { resolveIncidentRef } = require("./_incidentPath");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_APPROVE,
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

exports.assignVendorToJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");

    // Clear vs assign: an empty / null vendorId signals "clear the
    // assignment". Both vendorId and vendorName are optional in the
    // payload — vendorId presence is the deciding signal.
    const rawVendorId = String(body.vendorId == null ? "" : body.vendorId).trim();
    const rawVendorName = String(body.vendorName == null ? "" : body.vendorName).trim();
    const isClear = rawVendorId === "";

    // Role gate runs before any DB read.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_APPROVE);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[assignVendorToJobV1] authz_denied", {
        fn: "assignVendorToJobV1",
        orgId,
        incidentId,
        jobId,
        vendorId: rawVendorId || null,
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
    console.log("[assignVendorToJobV1] authz_ok", {
      fn: "assignVendorToJobV1",
      orgId,
      incidentId,
      jobId,
      vendorId: rawVendorId || null,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_APPROVE,
    });

    const db = getFirestore();

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Resolve the incident at canonical or legacy path; verify orgId
    // match. Mirrors the same posture as approveAndLockJobV1's fix
    // from Slice 4.
    const { ref: incRef } = await resolveIncidentRef(orgId, incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) {
      return j(res, 404, { ok: false, error: "incident_not_found" });
    }
    const incOrgId = String((incSnap.data() || {}).orgId || "").trim();
    if (incOrgId && incOrgId !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    // Job lives at the legacy top-level path
    // (incidents/{incidentId}/jobs/{jobId}) — same path the prior
    // client write used and the same path createJobV1 / approveJobV1
    // operate on.
    const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      return j(res, 404, { ok: false, error: "job_not_found" });
    }
    const job = jobSnap.data() || {};
    const jobOrgId = String(job.orgId || "").trim();
    if (jobOrgId && jobOrgId !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    // Vendor resolution (skip on clear).
    let resolvedVendorName = "";
    if (!isClear) {
      const vendorRef = db.doc(`orgs/${orgId}/vendors/${rawVendorId}`);
      const vendorSnap = await vendorRef.get();
      if (!vendorSnap.exists) {
        return j(res, 404, { ok: false, error: "vendor_not_found" });
      }
      const vendor = vendorSnap.data() || {};
      const vendorStatus = String(vendor.status || "active").trim().toLowerCase();
      if (vendorStatus === "archived") {
        return j(res, 409, { ok: false, error: "vendor_archived" });
      }
      // Canonical name from the vendor doc; body.vendorName is a hint
      // only. If the vendor doc has no name field, fall back to the
      // hint, then to vendorId.
      resolvedVendorName =
        String(vendor.name || "").trim()
          || rawVendorName
          || rawVendorId;
    }

    const previousVendorId = String(job.vendorId || "").trim() || null;
    const previousVendorName = String(job.vendorName || "").trim() || null;

    const patch = isClear
      ? {
          vendorId: null,
          vendorName: null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actorUid,
        }
      : {
          vendorId: rawVendorId,
          vendorName: resolvedVendorName,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actorUid,
        };

    await jobRef.set(patch, { merge: true });

    // Timeline event — best-effort. Same shape sibling functions
    // (approveJobV1, etc.) use: type, refId=jobId, actor=uid, meta.
    try {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "vendor_assigned",
        refId: jobId,
        actor: actorUid,
        meta: {
          cleared: isClear,
          vendorId: isClear ? null : rawVendorId,
          vendorName: isClear ? null : resolvedVendorName,
          previousVendorId,
          previousVendorName,
        },
      });
    } catch (e) {
      console.warn("[assignVendorToJobV1] timeline emit failed (non-fatal)", String(e?.message || e));
    }

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      jobId,
      vendorId: isClear ? null : rawVendorId,
      vendorName: isClear ? null : resolvedVendorName,
      cleared: isClear,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
