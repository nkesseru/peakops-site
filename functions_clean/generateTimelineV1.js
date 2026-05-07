const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_GENERATE_REPORT,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!getApps().length) initializeApp();
const db = getFirestore();

function readJson(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.rawBody) return JSON.parse(req.rawBody.toString("utf8") || "{}");
  } catch {}
  return {};
}

exports.generateTimelineV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const payload = readJson(req);
    const orgId = String(payload.orgId || req.query.orgId || "").trim();
    const incidentId = String(payload.incidentId || req.query.incidentId || "").trim();

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: timeline generation is admin-or-supervisor
    // only. Sibling of generateFilingsV1; same allow-list and same
    // chain-trace audit shape.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, payload));
      const gate = await assertActorRole(orgId, actorUid, ROLES_GENERATE_REPORT);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[generateTimelineV1] authz_denied", {
        fn: "generateTimelineV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_GENERATE_REPORT,
        code: e && e.code,
      });
      return res.status(httpStatusFromAuthzError(e)).json({
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[generateTimelineV1] authz_ok", {
      fn: "generateTimelineV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_GENERATE_REPORT,
    });

    const requestedBy = String(actorUid || payload.requestedBy || req.query.requestedBy || "unknown").trim();

    let incidentRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let snap = await incidentRef.get();
    if (!snap.exists) {
      incidentRef = db.collection("incidents").doc(incidentId);
      snap = await incidentRef.get();
    }

    // IMMUTABILITY_GUARD_C2
    const force = String((req.query && req.query.force) || (payload && payload.force) || (req.body && req.body.force) || "") === "1";
    const incident = snap.exists ? (snap.data() || {}) : {};
    if (incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }
    const nowIso = new Date().toISOString();
    const nowTs = Timestamp.now();

    const events = [
      {
        id: "t0_created",
        type: "INCIDENT_CREATED",
        title: "Incident created",
        message: snap.exists ? "Incident record exists." : "Incident record missing (timeline created anyway).",
        occurredAt: nowIso,
      },
      {
        id: "t1_timeline",
        type: "TIMELINE_GENERATED",
        title: "Timeline generated",
        message: "Stub timeline generated.",
        occurredAt: nowIso,
      },
    ];

    const batch = db.batch();
    const col = incidentRef.collection("timeline_events");

    for (const ev of events) {
      batch.set(
        col.doc(ev.id),
        {
          ...ev,
          orgId,
          incidentId,
          requestedBy,
          createdAt: nowTs,
          updatedAt: nowTs,
        },
        { merge: true }
      );
    }

    await batch.commit();

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      requestedBy,
      incidentExists: snap.exists,
      count: events.length,
      docs: events,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
