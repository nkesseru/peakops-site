const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveActor, requireOrgMember } = require("./jobAuthz");
const { emitTimelineEvent } = require("./timelineEmit");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.markJobCompleteV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");

    const db = getFirestore();
    const actor = await resolveActor(req, body);

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });
    const incident = incSnap.data() || {};
    if (String(incident.status || "").toLowerCase() === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed" });
    }

    const jobRef = incRef.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    const assignedOrgId = String(job.assignedOrgId || "").trim();
    if (!assignedOrgId || orgId !== assignedOrgId) {
      return j(res, 403, { ok: false, error: "assigned_org_required" });
    }

    await requireOrgMember(db, assignedOrgId, actor, { requiredRoles: [] });

    const prev = String(job.status || "open").toLowerCase();
    if (prev === "complete") {
      return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "complete", already: true });
    }
    if (!["open", "assigned", "in_progress"].includes(prev)) {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `${prev} -> complete not allowed` });
    }

    await jobRef.set(
      {
        status: "complete",
        reviewStatus: "none",
        completedAt: FieldValue.serverTimestamp(),
        completedBy: {
          uid: String(actor.uid || ""),
          email: String(actor.email || ""),
          orgId,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await emitTimelineEvent({
      orgId: String(incident.orgId || orgId),
      incidentId,
      type: "job_completed",
      refId: jobId,
      actor: "field",
      meta: { from: prev, to: "complete", assignedOrgId },
    });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "complete" });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
