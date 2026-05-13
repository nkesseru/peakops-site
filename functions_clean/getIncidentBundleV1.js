const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

exports.getIncidentBundleV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: incident bundle export is members-only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getIncidentBundleV1] authz_denied", {
        fn: "getIncidentBundleV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        capability: "read",
        code: e && e.code,
      });
      return res.status(httpStatusFromAuthzError(e)).json({
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[getIncidentBundleV1] authz_ok", {
      fn: "getIncidentBundleV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    let incidentRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let snap = await incidentRef.get();

    if (!snap.exists) {
      incidentRef = db.collection("incidents").doc(incidentId);
      snap = await incidentRef.get();
    }

    if (!snap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const incident = snap.data() || {};
    if (incident.orgId && String(incident.orgId) !== orgId) {
      return res.status(403).json({ ok: false, error: "orgId mismatch" });
    }

    // filings: prefer subcollection "filings", fallback to incident.filings array
    let filings = [];
    const filingsSnap = await incidentRef.collection("filings").get();
    if (!filingsSnap.empty) filings = filingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    else if (Array.isArray(incident.filings)) filings = incident.filings;

    // timeline optional
    let timeline = [];
    try {
      const tlSnap = await incidentRef.collection("timeline_events").orderBy("occurredAt", "asc").limit(200).get();
      timeline = tlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {}

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      incident,
      filings,
      timelineCount: timeline.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
