const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
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
    const approvedBy = String(body.approvedBy || "supervisor_ui");

    const db = getFirestore();
    await assertIncidentOrg(db, orgId, incidentId);

    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    const prev = String(data.status || "open").toLowerCase();
    if (prev === "approved") return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved", already: true });
    if (prev !== "complete" && prev !== "review") {
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

