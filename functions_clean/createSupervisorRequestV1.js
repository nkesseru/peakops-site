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

exports.createSupervisorRequestV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: requesting supervisor attention is field-or-
    // above. Replaces the previous `actorUid || "dev-admin"` body
    // fallback. Bare smoke calls without a real or seeded uid now
    // fail closed.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createSupervisorRequestV1] authz_denied", {
        fn: "createSupervisorRequestV1",
        orgId,
        incidentId,
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
    console.log("[createSupervisorRequestV1] authz_ok", {
      fn: "createSupervisorRequestV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const message = String(body.message || body.note || "").trim();
    const reasons = Array.isArray(body.reasons) ? body.reasons.map((x) => String(x || "").trim()).filter(Boolean) : [];
    const jobId = String(body.jobId || "").trim();
    const evidenceId = String(body.evidenceId || "").trim();

    if (!message && reasons.length === 0) {
      return j(res, 400, { ok: false, error: "message_or_reasons_required" });
    }

    const db = getFirestore();
    const reqRef = db.collection("incidents").doc(incidentId).collection("supervisor_requests").doc();
    const id = reqRef.id;

    const doc = {
      id,
      orgId,
      incidentId,
      jobId: jobId || null,
      evidenceId: evidenceId || null,
      message: message || null,
      reasons,
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actorUid,
    };

    await reqRef.set(doc, { merge: true });

    // timeline event
    const tlId = `supervisor_request_${id}`;
    await db.collection("incidents").doc(incidentId).collection("timeline_events").doc(tlId).set({
      id: tlId,
      type: "SUPERVISOR_REQUEST_UPDATE",
      orgId,
      incidentId,
      jobId: jobId || null,
      evidenceId: evidenceId || null,
      requestId: id,
      actorUid,
      occurredAt: FieldValue.serverTimestamp(),
      message: message || null,
      reasons,
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, requestId: id, id, status: "open" });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
