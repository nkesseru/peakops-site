const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!getApps().length) initializeApp();
const db = getFirestore();

exports.getIncidentPacketMetaV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6.1: packet metadata read is members-only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getIncidentPacketMetaV1] authz_denied", {
        fn: "getIncidentPacketMetaV1",
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
    console.log("[getIncidentPacketMetaV1] authz_ok", {
      fn: "getIncidentPacketMetaV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    let snap = await db.doc(`orgs/${orgId}/incidents/${incidentId}`).get();
    if (!snap.exists) {
      snap = await db.collection("incidents").doc(incidentId).get();
    }
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Incident not found" });
    }

    const data = snap.data() || {};

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Phase 1 Slice 6.1 caught this leak in smoke: the membership
    // gate above confirms the *caller* belongs to orgId, not that the
    // *incident* belongs to orgId. Mirror the same check
    // getIncidentV1 / getIncidentBundleV1 already perform.
    const _incOrgId = String(data.orgId || "").trim();
    if (_incOrgId && _incOrgId !== orgId) {
      return res.status(409).json({ ok: false, error: "org_mismatch" });
    }

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      packetMeta: data.packetMeta || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
