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

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

async function assertIncidentOrg(db, orgId, incidentId) {
  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("incident_not_found");
  const inc = incSnap.data() || {};
  const incOrgId = String(inc.orgId || "").trim();
  if (incOrgId && incOrgId !== orgId) throw new Error("org_mismatch");
}

// POST { orgId, incidentId, jobId, approvedBy? }
exports.approveJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: approve action is admin-or-supervisor only.
    // Upgraded from the Slice 3 membership-only gate to the role
    // allow-list. Runs before the incident existence check so non-
    // members cannot probe whether an incident exists.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_APPROVE);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[approveJobV1] authz_denied", {
        fn: "approveJobV1",
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
    console.log("[approveJobV1] authz_ok", {
      fn: "approveJobV1",
      orgId,
      incidentId,
      jobId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_APPROVE,
    });

    const approvedBy = String(body.approvedBy || actorUid || "supervisor_ui");

    const db = getFirestore();
    await assertIncidentOrg(db, orgId, incidentId);

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Closed records are immutable. Job approval is a state mutation;
    // reject it post-closure. If approval is genuinely needed after a
    // record is sealed, the operational answer is an addendum
    // (PR 43), not retroactive job-state changes.
    const sealIncSnap = await db.collection("incidents").doc(incidentId).get();
    const sealIncStatus = String((sealIncSnap.exists ? (sealIncSnap.data() || {}) : {}).status || "").toLowerCase();
    if (sealIncStatus === "closed") {
      return j(res, 409, {
        ok: false,
        error: "incident_closed",
        detail: "Operational record is sealed — file an addendum to attach supplemental context.",
      });
    }

    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    const prev = String(data.status || "open").toLowerCase();
    if (prev === "approved") return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved", already: true });
    if (prev !== "review") {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `${prev} -> approved not allowed` });
    }

    await ref.set(
      {
        status: "approved",
        approvedBy,
        approvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await emitTimelineEvent({
      orgId,
      incidentId,
      type: "job_approved",
      refId: jobId,
      actor: approvedBy,
      meta: { from: prev, to: "approved" },
    });
    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved" });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
