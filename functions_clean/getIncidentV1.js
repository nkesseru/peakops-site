const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  assertActorCanReadOrg,
  assertIncidentBelongsToOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function isDemoBypass(req) {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" &&
    String(req.get?.("x-peakops-demo") || "") === "1";
}

exports.getIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: incident read is members-only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getIncidentV1] authz_denied", {
        fn: "getIncidentV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        capability: "read",
        code: e && e.code,
      });
      return send(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[getIncidentV1] authz_ok", {
      fn: "getIncidentV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    let snap = await db.doc(`orgs/${orgId}/incidents/${incidentId}`).get();
    let source = "orgs";

    if (!snap.exists) {
      snap = await db.collection("incidents").doc(incidentId).get();
      source = "top_level";
    }

    if (!snap.exists) return send(res, 404, { ok: false, error: "Incident not found" });

    // PEAKOPS_TENANT_ISOLATION_V1 (Chunk 1, 2026-06-22)
    // Centralized org-isolation guard. Returns 404 (was 409 — leaked
    // existence of foreign incident). Demo bypass preserved for emulator-
    // only cross-org reads triggered by `x-peakops-demo: 1`.
    if (!isDemoBypass(req)) {
      const iso = assertIncidentBelongsToOrg(snap, orgId, {
        fn: "getIncidentV1",
        incidentId,
        actorUid,
      });
      if (!iso.match) {
        return send(res, 404, { ok: false, error: "Incident not found" });
      }
    }

    const data = snap.data() || {};
    const doc = { id: snap.id, ...data };
    return send(res, 200, { ok: true, orgId, incidentId, source, doc });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
