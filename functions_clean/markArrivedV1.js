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

function normGps(gps) {
  if (!gps || typeof gps !== "object") return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const accuracyM = gps.accuracyM == null ? null : Number(gps.accuracyM);
  const source = String(gps.source || "device");
  return {
    lat,
    lng,
    accuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
    source,
  };
}

// POST body: { orgId, incidentId, sessionId, gps?, requestedBy? }
exports.markArrivedV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");
    const requestedBy = String(body.requestedBy || "ui");
    const gps = normGps(body.gps);

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incStatus = String((incSnap.exists ? (incSnap.data() || {}) : {}).status || "").toLowerCase();
    if (incStatus === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed", detail: "Incident is read-only" });
    }
    const sessionRef =
      db.collection("orgs").doc(orgId)
        .collection("incidents").doc(incidentId)
        .collection("fieldSessions").doc(sessionId);

    // Only set arrival once (idempotent-ish)
    const snap = await sessionRef.get();
    if (!snap.exists) return j(res, 404, { ok: false, error: "session not found" });

    const data = snap.data() || {};
    if (data.arrivalAt) {
      await emitTimelineEvent({ orgId, incidentId, type: "FIELD_ARRIVED", sessionId, gps, actor: requestedBy, meta: { already: true } });
      return j(res, 200, { ok: true, orgId, incidentId, sessionId, arrivalAt: data.arrivalAt, already: true });
    }

    const arrivalAt = FieldValue.serverTimestamp();

    await sessionRef.set(
      {
        arrivalAt,
        arrivalGps: gps,
        arrivalRequestedBy: requestedBy,
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "FIELD_ARRIVED", sessionId, gps, actor: requestedBy });

    return j(res, 200, { ok: true, orgId, incidentId, sessionId });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
