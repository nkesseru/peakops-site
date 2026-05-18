require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.approveAndLockJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const jobId = mustStr(body.jobId, "jobId");
    const actorUid = String(body.actorUid || body.actorId || "dev").trim() || "dev";

    const db = getFirestore();

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Sealed operational records are immutable. Reject approve+lock
    // post-closure. Post-closure supervisory follow-up goes through
    // the addendum model (PR 43).
    const sealIncSnap = await db.collection("incidents").doc(incidentId).get();
    const sealIncStatus = String((sealIncSnap.exists ? (sealIncSnap.data() || {}) : {}).status || "").toLowerCase();
    if (sealIncStatus === "closed") {
      return j(res, 409, {
        ok: false,
        error: "incident_closed",
        detail: "Operational record is sealed — file an addendum to attach supplemental context.",
      });
    }

    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);

    await ref.set({
      orgId,
      assignedOrgId: orgId,
      status: "approved",
      reviewStatus: "approved",
      locked: true,
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await emitTimelineEvent({
      orgId,
      incidentId,
      type: "job_approved",
      refId: jobId,
      actor: actorUid,
      meta: { locked: true },
    });

    return j(res, 200, { ok: true, orgId, incidentId, jobId, status: "approved", locked: true });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
