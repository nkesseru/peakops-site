const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

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

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: field arrival is field-or-above. Runs before
    // the incident-existence read so non-members cannot probe.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[markArrivedV1] authz_denied", {
        fn: "markArrivedV1",
        orgId,
        incidentId,
        sessionId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[markArrivedV1] authz_ok", {
      fn: "markArrivedV1",
      orgId,
      incidentId,
      sessionId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const requestedBy = String(actorUid || body.requestedBy || "ui");
    const gps = normGps(body.gps);

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incStatus = String((incSnap.exists ? (incSnap.data() || {}) : {}).status || "").toLowerCase();
    if (incStatus === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed", detail: "Incident is read-only" });
    }
    if (incStatus && incStatus !== "open" && incStatus !== "in_progress") {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `unsupported incident.status=${incStatus}` });
    }
    const sessionRef =
      db.collection("incidents").doc(incidentId)
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
