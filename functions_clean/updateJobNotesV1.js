const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveActor, requireOrgMember } = require("./jobAuthz");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

async function assertNotesAccess({ db, actor, requestOrgId, incidentOrgId, assignedOrgId }) {
  if (requestOrgId === incidentOrgId) {
    await requireOrgMember(db, incidentOrgId, actor, { requiredRoles: ["owner", "admin"] });
    return "incident_admin";
  }
  if (assignedOrgId && requestOrgId === assignedOrgId) {
    await requireOrgMember(db, assignedOrgId, actor, { requiredRoles: [] });
    return "assigned_org_member";
  }
  const err = new Error("forbidden");
  err.statusCode = 403;
  throw err;
}

exports.updateJobNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
    const notes = String(body.notes || "").slice(0, 4000);

    const db = getFirestore();
    const actor = await resolveActor(req, body);

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

    await assertNotesAccess({
      db,
      actor,
      requestOrgId: orgId,
      incidentOrgId,
      assignedOrgId,
    });

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
