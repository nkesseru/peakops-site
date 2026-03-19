require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId).collection("evidence_locker").doc(evidenceId);

    await ref.set({
      orgId,
      assignedOrgId: orgId,
      label,
      labels: label ? [label] : [],
      labelUpdatedAt: FieldValue.serverTimestamp(),
      labelUpdatedBy: String(body.actorUid || body.actorId || "dev").trim() || "dev",
    }, { merge: true });

    return j(res, 200, { ok: true, orgId, incidentId, evidenceId, label });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
