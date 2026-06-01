// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119a)
//
// List all customer / org-wide acceptance templates under
// orgs/{orgId}/templates/. Powers the /admin/templates list page
// in the upcoming PR 119b UI.
//
// Scope (per PR 119 plan):
//   - Admin/owner only (ROLES_ADMIN_ONLY). Editing what a customer
//     requires is a contract-level decision; supervisors execute,
//     they don't configure.
//   - Lightweight summary projection per row — count fields only,
//     NOT full requiredProof / acceptanceChecks arrays. The list
//     page only needs to show "edited 3d ago by alice, v3, 7
//     required-proof items, 3 acceptance checks." Detail load
//     happens on the edit-page route reading the doc directly.
//
// Returns docs in updatedAt-desc order (most recently edited first
// surfaces — matches the operator's mental model "who changed what
// last"). Falls back to createdAt for templates that never got
// updated past their initial seed write.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

exports.listOrgTemplatesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = String(req.query?.orgId || "").trim();
    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });

    // PEAKOPS_AUTHZ_TEMPLATES_V1 (PR 119a)
    // Admin/owner only. Template authoring is contract-level work.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[listOrgTemplatesV1] authz_denied", {
        fn: "listOrgTemplatesV1",
        orgId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_ADMIN_ONLY,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[listOrgTemplatesV1] authz_ok", {
      fn: "listOrgTemplatesV1", orgId, uid: actorUid, role: actorRole,
    });

    const db = getFirestore();
    const snap = await db.collection(`orgs/${orgId}/templates`).get();
    const templates = snap.docs
      .map((d) => {
        const data = d.data() || {};
        const archetype = String(data.archetype || "").trim();
        const customerSlug = String(data.customerSlug || "").trim();
        const customerLabel = String(data.customerLabel || "").trim();
        const requiredProofCount = Array.isArray(data.requiredProof) ? data.requiredProof.length : 0;
        const optionalProofCount = Array.isArray(data.optionalProof) ? data.optionalProof.length : 0;
        const acceptanceCriteriaCount = Array.isArray(data.acceptanceCriteria) ? data.acceptanceCriteria.length : 0;
        const acceptanceChecksCount = Array.isArray(data.acceptanceChecks) ? data.acceptanceChecks.length : 0;
        const version = Number(data.version);
        return {
          templateKey: d.id,
          archetype,
          customerSlug,
          customerLabel,
          requiredProofCount,
          optionalProofCount,
          acceptanceCriteriaCount,
          acceptanceChecksCount,
          version: Number.isFinite(version) && version > 0 ? version : 0,
          createdAt: tsIso(data.createdAt),
          createdBy: String(data.createdBy || ""),
          updatedAt: tsIso(data.updatedAt),
          updatedBy: String(data.updatedBy || ""),
        };
      })
      .filter((t) => t.archetype.length > 0)  // drop unrelated docs under templates/ subcollection
      .sort((a, b) => {
        const aTs = Date.parse(a.updatedAt || a.createdAt || "") || 0;
        const bTs = Date.parse(b.updatedAt || b.createdAt || "") || 0;
        return bTs - aTs;
      });

    return j(res, 200, { ok: true, orgId, templates });
  } catch (e) {
    console.error("[listOrgTemplatesV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
