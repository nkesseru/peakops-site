const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

// GET /getIncidentNotesV1?orgId=...&incidentId=...
exports.getIncidentNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: incident-notes read is members-only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getIncidentNotesV1] authz_denied", {
        fn: "getIncidentNotesV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        capability: "read",
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[getIncidentNotesV1] authz_ok", {
      fn: "getIncidentNotesV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    // PEAKOPS_RESOURCE_INTEGRITY_V1 (2026-05-06)
    // Phase 1 Slice 6.1: notes docs at `incidents/{id}/notes/main` do
    // NOT carry an orgId field of their own — verifying ownership
    // requires reading the parent incident. Without this check, a
    // demo-org member who guesses an other-org incidentId could read
    // its notes. Read the parent incident from canonical/legacy paths
    // and compare orgId before returning notes.
    let _incOrgId = "";
    let _incExisted = false;
    {
      let _incSnap = await db.doc(`orgs/${orgId}/incidents/${incidentId}`).get();
      if (!_incSnap.exists) {
        _incSnap = await db.collection("incidents").doc(incidentId).get();
      }
      if (_incSnap.exists) {
        _incExisted = true;
        _incOrgId = String((_incSnap.data() || {}).orgId || "").trim();
      }
    }
    if (_incExisted && _incOrgId && _incOrgId !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    const ref = db.doc(`incidents/${incidentId}/notes/main`);
    const snap = await ref.get();

    if (!snap.exists) return j(res, 200, { ok: true, orgId, incidentId, notes: { incidentNotes: "", siteNotes: "" } });

    return j(res, 200, { ok: true, orgId, incidentId, notes: snap.data() || {} });
  } catch (e) {
    console.error("getIncidentNotesV1 error", e);
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
