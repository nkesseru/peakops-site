const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!getApps().length) initializeApp();
const db = getFirestore();

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6.1: workflow read is members-only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getWorkflowV1] authz_denied", {
        fn: "getWorkflowV1",
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
    console.log("[getWorkflowV1] authz_ok", {
      fn: "getWorkflowV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    let incidentRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let incidentSnap = await incidentRef.get();

    if (!incidentSnap.exists) {
      incidentRef = db.collection("incidents").doc(incidentId);
      incidentSnap = await incidentRef.get();
    }

    if (!incidentSnap.exists) {
      return res.status(404).json({ ok: false, error: "Incident not found" });
    }

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Phase 1 Slice 6.1 caught this leak in smoke: the membership
    // gate above confirms the *caller* belongs to orgId, not that the
    // *incident* belongs to orgId. Without this check, an incident
    // stored with orgId="other-org" would still be returned to a
    // demo-org member who guessed its incidentId. Mirror the same
    // check getIncidentV1 / getIncidentBundleV1 already perform.
    const _incData = incidentSnap.data() || {};
    const _incOrgId = String(_incData.orgId || "").trim();
    if (_incOrgId && _incOrgId !== orgId) {
      return res.status(409).json({ ok: false, error: "org_mismatch" });
    }

    const packetMeta = _incData.packetMeta || null;
    const exportReady = !!(packetMeta && packetMeta.packetHash);

    // ---- derive readiness from Firestore ----
    const filingsSnap = await incidentRef.collection("filings").limit(1).get();
    const filingsReady = filingsSnap.size > 0;

    const timelineSnap = await incidentRef.collection("timeline_events").limit(1).get();
    const timelineReady = timelineSnap.size > 0;

    // ---- build workflow deterministically ----
    const steps = [
      { key: "intake",   title: "Intake",           status: "DONE" },
      { key: "timeline", title: "Build Timeline",   status: timelineReady ? "DONE" : "TODO" },
      { key: "filings",  title: "Generate Filings", status: filingsReady ? "DONE" : "TODO" },
      { key: "export",   title: "Export Packet",    status: exportReady ? "DONE" : "TODO" },
    ];

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident: { id: incidentId, ...incidentSnap.data() },
      workflow: {
        version: "v1",
        steps,
        filingsReady,
        exportReady: exportReady,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
