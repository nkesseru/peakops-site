const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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
  const incStatus = String(inc.status || "").toLowerCase();
  if (incStatus === "closed") {
    const err = new Error("incident_closed");
    err.statusCode = 409;
    throw err;
  }
}

// POST { orgId, incidentId, evidenceId, jobId? } where jobId may be empty/null to unassign.
exports.assignEvidenceToJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const evidenceId = mustStr(body.evidenceId, "evidenceId");
    const jobId = String(body.jobId || "").trim();
const db = getFirestore();
    // PEAKOPS_LOCK_ENFORCE_V1 (fixed placement)
    // Block any mutations to a locked/approved job.
    const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(String(jobId));
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    const locked = !!job.locked || String(job.status || "").toLowerCase() === "approved";
    if (locked) return j(res, 423, { ok: false, error: "locked", jobId });

    await assertIncidentOrg(db, orgId, incidentId);

    if (jobId) {
      const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
      const jobSnap = await jobRef.get();
      if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
      const job = jobSnap.data() || {};
      if (String(job.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    const evRef = db.collection("incidents").doc(incidentId).collection("evidence_locker").doc(evidenceId);
    const evSnap = await evRef.get();
    if (!evSnap.exists) return j(res, 404, { ok: false, error: "evidence_not_found" });
    const ev = evSnap.data() || {};
    if (String(ev.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });

    if (jobId) {
      await evRef.update({
        jobId,
        "evidence.jobId": jobId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await evRef.update({
        "evidence.jobId": FieldValue.delete(),
        jobId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return j(res, 200, { ok: true, orgId, incidentId, evidenceId, jobId: jobId || null });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
