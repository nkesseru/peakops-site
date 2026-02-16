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

// POST body: { orgId, incidentId, closedBy? }
exports.closeIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const closedBy = String(body.closedBy || "ui");

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const snap = await incRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const status = String(data.status || "").toLowerCase();

    if (status === "closed") {
      return j(res, 200, { ok: true, orgId, incidentId, status: "closed", already: true });
    }
    if (status && status !== "submitted") {
      return j(res, 409, {
        ok: false,
        error: "invalid_transition",
        detail: `closeIncident requires status=submitted; current=${status}`,
      });
    }

    await incRef.set(
      {
        orgId,
        incidentId,
        status: "closed",
        closedAt: FieldValue.serverTimestamp(),
        closedBy,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "incident_closed", actor: closedBy });
    return j(res, 200, { ok: true, orgId, incidentId, status: "closed" });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});

