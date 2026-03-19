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

exports.createSupervisorRequestV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const actorUid = String(body.actorUid || body.actorId || "dev-admin").trim() || "dev-admin";

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
