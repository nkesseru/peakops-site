require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_CREATE_JOB,
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

exports.createJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const title = mustStr(body.title || body.jobTitle || body.name, "title");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: createJob is admin-or-supervisor only by spec
    // default. Field-created jobs are not currently a documented flow;
    // if/when product confirms field users create jobs through this
    // path, swap ROLES_CREATE_JOB → ROLES_FIELD_WORK and rerun smoke.
    // The gate also replaces the previous `actorUid || "dev"` body
    // fallback — bare "dev" smoke calls without a seeded membership
    // now fail closed.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_CREATE_JOB);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createJobV1] authz_denied", {
        fn: "createJobV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_CREATE_JOB,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[createJobV1] authz_ok", {
      fn: "createJobV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_CREATE_JOB,
    });

    const db = getFirestore();

    // ✅ Must match listJobsV1/getJobV1
    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc();

    const now = FieldValue.serverTimestamp();
    await ref.set({
      id: ref.id,
      incidentId,
      orgId,            // important for org checks
      assignedOrgId: orgId,
      title,
      status: "open",
      createdAt: now,
      updatedAt: now,
      createdBy: actorUid,
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, jobId: ref.id, id: ref.id, title, status: "open" });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
