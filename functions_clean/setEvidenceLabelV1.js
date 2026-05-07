require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
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

exports.setEvidenceLabelV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const evidenceId = mustStr(body.evidenceId, "evidenceId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: setting evidence labels is field-or-above.
    // Side-fix: the prior code referenced `db` before declaring it
    // (db was declared on what used to be line 42 but used on line
    // 27). Promoted the `const db = getFirestore()` declaration
    // above the lock-enforcement read so the function actually
    // executes rather than ReferenceError-ing on every call.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[setEvidenceLabelV1] authz_denied", {
        fn: "setEvidenceLabelV1",
        orgId,
        incidentId,
        evidenceId,
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
    console.log("[setEvidenceLabelV1] authz_ok", {
      fn: "setEvidenceLabelV1",
      orgId,
      incidentId,
      evidenceId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const db = getFirestore();

    // PEAKOPS_LOCK_ENFORCE_V1
    // If evidence is linked to a job and that job is locked, prevent label edits.
    const evRef = db.collection("incidents").doc(incidentId).collection("evidence_locker").doc(String(evidenceId));
    const evSnap = await evRef.get();
    if (evSnap.exists) {
      const ev = evSnap.data() || {};
      const linkedJobId = String(ev.jobId || ev.evidence_jobId || "").trim();
      if (linkedJobId) {
        const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(linkedJobId);
        const jobSnap = await jobRef.get();
        const job = jobSnap.exists ? (jobSnap.data() || {}) : {};
        const locked = !!job.locked || String(job.status || "").toLowerCase() === "approved";
        if (locked) return j(res, 423, { ok: false, error: "locked", jobId: linkedJobId });
      }
    }

    const label = String(body.label || "").trim();
    const ref = db.collection("incidents").doc(incidentId).collection("evidence_locker").doc(evidenceId);

    await ref.set({
      orgId,
      assignedOrgId: orgId,
      label,
      labels: label ? [label] : [],
      labelUpdatedAt: FieldValue.serverTimestamp(),
      labelUpdatedBy: actorUid,
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, evidenceId, label });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
