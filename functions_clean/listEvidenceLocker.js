const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { handleListEvidenceLockerRequest } = require("./evidenceLockerApi.mjs");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

// PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
// Phase 1 Slice 6: gate the evidence-locker listing at the wrapper
// before delegating to the ESM handler. Listing the locker exposes
// every photo's storagePath / metadata for an incident — a
// non-member with an incidentId guess could otherwise enumerate
// evidence without ever needing the signed-URL path. Gate here, log
// the chain trace, then pass through to the existing handler
// implementation in evidenceLockerApi.mjs unchanged.
exports.listEvidenceLocker = onRequest({ cors: true }, async (req, res) => {
  if (String(req.method || "").toUpperCase() !== "GET") {
    // The handler also rejects non-GET, but we short-circuit here
    // so the gate's audit trail isn't burdened with non-GET noise.
    return res
      .status(405)
      .set("content-type", "application/json")
      .send(JSON.stringify({ ok: false, error: "Use GET" }));
  }

  const orgId = String(req.query?.orgId || "").trim();
  const incidentId = String(req.query?.incidentId || "").trim();

  if (!orgId) {
    return res
      .status(400)
      .set("content-type", "application/json")
      .send(JSON.stringify({ ok: false, error: "Missing orgId/incidentId" }));
  }

  let actorUid = "";
  let actorRole = null;
  try {
    ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
    const gate = await assertActorCanReadOrg(orgId, actorUid);
    actorRole = (gate.membership && gate.membership.role) || null;
  } catch (e) {
    console.warn("[listEvidenceLocker] authz_denied", {
      fn: "listEvidenceLocker",
      orgId,
      incidentId,
      uid: actorUid,
      role: (e && e.details && e.details.role) || null,
      capability: "read",
      code: e && e.code,
    });
    return res
      .status(httpStatusFromAuthzError(e))
      .set("content-type", "application/json")
      .send(
        JSON.stringify({
          ok: false,
          error: (e && e.code) || "permission-denied",
          count: 0,
          docs: [],
        }),
      );
  }
  console.log("[listEvidenceLocker] authz_ok", {
    fn: "listEvidenceLocker",
    orgId,
    incidentId,
    uid: actorUid,
    role: actorRole,
    capability: "read",
  });

  return handleListEvidenceLockerRequest(req, res);
});
