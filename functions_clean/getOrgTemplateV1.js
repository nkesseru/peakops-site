// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 125a)
//
// Read-only fetch of a single acceptance template at
// orgs/{orgId}/templates/{templateKey}. Powers the /admin/templates
// editor's load path so reopening a saved template rehydrates the
// full doc (arrays + provenance) instead of falling back to the
// summary projection from listOrgTemplatesV1.
//
// Scope:
//   - Admin/owner only (ROLES_ADMIN_ONLY), same gate as
//     listOrgTemplatesV1 + saveOrgTemplateV1.
//   - Read-only. Never writes Firestore.
//   - Returns the full doc — all arrays + provenance fields. Counts
//     stay in listOrgTemplatesV1 for the list view; this is the
//     detail surface.
//   - 404 when the document doesn't exist. No fallback to summary;
//     the editor needs to hard-error on missing identity rather than
//     silently start a blank create flow.

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

exports.getOrgTemplateV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = String(req.query?.orgId || "").trim();
    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });

    const templateKey = String(req.query?.templateKey || "").trim();
    if (!templateKey) return j(res, 400, { ok: false, error: "Missing templateKey" });

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getOrgTemplateV1] authz_denied", {
        fn: "getOrgTemplateV1",
        orgId,
        templateKey,
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
    console.log("[getOrgTemplateV1] authz_ok", {
      fn: "getOrgTemplateV1", orgId, templateKey, uid: actorUid, role: actorRole,
    });

    const db = getFirestore();
    const docRef = db.doc(`orgs/${orgId}/templates/${templateKey}`);
    const snap = await docRef.get();
    if (!snap.exists) {
      return j(res, 404, {
        ok: false,
        error: "template_not_found",
        orgId,
        templateKey,
      });
    }

    const data = snap.data() || {};
    const version = Number(data.version);

    const template = {
      templateKey: snap.id,
      archetype: String(data.archetype || "").trim(),
      customerSlug: String(data.customerSlug || "").trim(),
      customerLabel: String(data.customerLabel || "").trim(),
      requiredProof: Array.isArray(data.requiredProof) ? data.requiredProof.slice() : [],
      requiredProofDescriptions: Array.isArray(data.requiredProofDescriptions)
        ? data.requiredProofDescriptions.slice()
        : [],
      optionalProof: Array.isArray(data.optionalProof) ? data.optionalProof.slice() : [],
      acceptanceCriteria: Array.isArray(data.acceptanceCriteria) ? data.acceptanceCriteria.slice() : [],
      acceptanceChecks: Array.isArray(data.acceptanceChecks) ? data.acceptanceChecks.slice() : [],
      version: Number.isFinite(version) && version > 0 ? version : 0,
      createdAt: tsIso(data.createdAt),
      createdBy: String(data.createdBy || ""),
      updatedAt: tsIso(data.updatedAt),
      updatedBy: String(data.updatedBy || ""),
    };

    return j(res, 200, { ok: true, orgId, templateKey: snap.id, template });
  } catch (e) {
    console.error("[getOrgTemplateV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
