const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");

if (!admin.apps.length) admin.initializeApp();

const ALLOWED = new Set(["open", "in_progress", "complete", "review", "approved", "rejected"]);
const TRANSITIONS = {
  open: new Set(["open", "in_progress", "complete"]),
  assigned: new Set(["assigned", "in_progress", "complete"]),
  in_progress: new Set(["in_progress", "complete"]),
  complete: new Set(["complete", "review"]),
  review: new Set(["review", "approved", "rejected"]),
  approved: new Set(["approved"]),
  rejected: new Set(["rejected"]),
};

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

// POST { orgId, incidentId, jobId, status, notes? }
exports.updateJobStatusV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
const status = mustStr(body.status, "status").toLowerCase();
    if (!ALLOWED.has(status)) return j(res, 400, { ok: false, error: "invalid_status" });
    const notes = String(body.notes || "").trim().slice(0, 1200);

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

    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    const prev = String(data.status || "open").toLowerCase();
    if (!TRANSITIONS[prev] || !TRANSITIONS[prev].has(status)) {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `${prev} -> ${status} not allowed` });
    }

    const nextPatch = {
      status,
      notes: notes || data.notes || null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (status === "complete") {
      nextPatch.completedAt = FieldValue.serverTimestamp();
      nextPatch.completedBy = {
        uid: String(body.actorUid || body.updatedBy || ""),
        email: String(body.actorEmail || ""),
        orgId,
      };
    }
    await ref.set(nextPatch, { merge: true });
    if (prev !== status && status === "complete") {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "job_completed",
        refId: jobId,
        actor: String(body.updatedBy || "field_ui"),
        meta: { from: prev, to: status },
      });
    }
    if (prev !== status && status === "review") {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "job_reviewed",
        refId: jobId,
        actor: String(body.updatedBy || "supervisor_ui"),
        meta: { from: prev, to: status },
      });
    }
    return j(res, 200, { ok: true, orgId, incidentId, jobId, status });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
