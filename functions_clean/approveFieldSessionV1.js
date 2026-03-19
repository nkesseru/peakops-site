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

// POST body: { orgId, incidentId, sessionId, approvedBy? }
exports.approveFieldSessionV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok:false, error:"POST required" });

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");
    const approvedBy = String(body.approvedBy || "supervisor_ui");

    const db = getFirestore();
    const sesRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);

    const snap = await sesRef.get();
    if (!snap.exists) return j(res, 404, { ok:false, error:"session not found" });

    const data = snap.data() || {};
    if (data.status === "APPROVED") {
      await emitTimelineEvent({ orgId, incidentId, type: "FIELD_APPROVED", sessionId, actor: approvedBy, meta: { already: true } });
      return j(res, 200, { ok:true, orgId, incidentId, sessionId, already:true, status:"APPROVED" });
    }

    // Soft rule: recommend SUBMITTED first (but allow approve anyway)
    const wasSubmitted = data.status === "SUBMITTED";

    await sesRef.set(
      {
        status: "APPROVED",
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy,
        approvedFromStatus: String(data.status || ""),
        wasSubmitted
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "FIELD_APPROVED", sessionId, actor: approvedBy, meta: { wasSubmitted } });

    return j(res, 200, { ok:true, orgId, incidentId, sessionId, status:"APPROVED", wasSubmitted });
  } catch (e) {
    return j(res, 400, { ok:false, error:String(e?.message || e) });
  }
});
