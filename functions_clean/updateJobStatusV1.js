const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");

if (!admin.apps.length) admin.initializeApp();

const ALLOWED = new Set(["open", "in_progress", "complete", "review", "approved", "rejected"]);
const TRANSITIONS = {
  open: new Set(["open", "in_progress", "rejected"]),
  in_progress: new Set(["in_progress", "complete", "review", "rejected"]),
  complete: new Set(["complete", "review", "approved", "rejected"]),
  review: new Set(["review", "approved", "rejected", "in_progress"]),
  approved: new Set(["approved"]),
  rejected: new Set(["rejected", "in_progress", "review"]),
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

    await ref.set(
      {
        status,
        notes: notes || data.notes || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
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
    return j(res, 200, { ok: true, orgId, incidentId, jobId, status });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
