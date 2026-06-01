// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119a)
//
// Create or update a customer / org-wide acceptance template under
// orgs/{orgId}/templates/{templateKey}. Powers the /admin/templates
// editor (PR 119b UI).
//
// Scope (per PR 119 plan):
//   - Admin/owner only (ROLES_ADMIN_ONLY).
//   - All-or-nothing validation: if any field fails, the whole save
//     is rejected with a clear error code. Avoids partial-save
//     corruption.
//   - Versioning: monotonic `version` field, increments by 1 per
//     save. Created-by/at written only on the first save (v1).
//     Updated-by/at refreshed every save. No history collection in
//     this PR — per-incident snapshot freezing (PR 104/118) already
//     gives us forensic replay at the record level.
//   - admin_audit append on every successful save, mirrors the
//     teamRecoveryV1 pattern (best-effort; never fails the parent
//     operation).
//
// Templates the customer/orgs use today:
//   templateKey = `${archetype}__${customerSlug}`   (customer-specific)
//   templateKey = archetype                          (org-wide)
//
// Snapshot compatibility:
//   Existing incidents keep their frozen requirements snapshot (PR 104
//   audit contract). Template edits only affect NEW incident creation.

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { toCustomerSlug } = require("./_customerSlug");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

// Duplicated from createIncidentV1.js (line 188) — kept in sync by
// hand for now. Future PR can extract to a shared _archetypeEnum.js
// module. Sync rule: never remove a value from this list; only
// append (backwards-compat with already-persisted incidents).
const ARCHETYPE_ENUM = [
  "pole_inspection",
  "splice_work",
  "cable_install",
  "site_survey",
  "custom",
  "fiber_splice_verification",
  "site_acceptance",
  "storm_restoration_proof",
];

// Mirrors _readiness.js TEMPLATE_CHECK_EVALUATORS map keys (PR 104).
// Sync rule: same as above — append-only.
const ACCEPTANCE_CHECK_TYPES = [
  "requires_minimum_proof_count",
  "requires_supervisor_approval",
  "requires_at_least_one_gps_proof",
  "requires_field_notes",
  "requires_incident_closure",
];

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

// PR 118 — same sanitize used by createIncidentV1.js for snapshot
// writes. Repeated here so customer-template prose lands in Firestore
// in the same shape readers expect.
function sanitizeProse(raw, maxLen) {
  const s = String(raw || "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
  return s.length > 0 ? s.slice(0, maxLen) : "";
}

// Validates + normalizes the inbound acceptanceChecks array, applying
// the same shape rules createIncidentV1.js applies at snapshot write
// time (PR 104 + PR 118). Drops malformed entries silently — the
// editor's responsibility is to surface validation BEFORE save
// arrives here; this is the server's last-line defense.
function sanitizeChecksArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === "object" && ACCEPTANCE_CHECK_TYPES.includes(String(c.type || "").trim()))
    .map((c) => {
      const out = {
        type: String(c.type).trim(),
        tier: c.tier === "required" ? "required" : "encouraged",
      };
      if (c.params && typeof c.params === "object") {
        out.params = c.params;
      }
      const label = sanitizeProse(c.label, 200);
      if (label) out.label = label;
      const description = sanitizeProse(c.description, 500);
      if (description) out.description = description;
      return out;
    });
}

function sanitizeStringList(raw, maxItems, maxLen) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => sanitizeProse(s, maxLen))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

async function writeAuditEntry(db, entry) {
  // Best-effort — never fail the parent operation on audit failure.
  // Mirrors teamRecoveryV1.writeAuditEntry pattern.
  try {
    await db
      .collection("orgs")
      .doc(trimStr(entry.orgId))
      .collection("admin_audit")
      .add({
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error("[saveOrgTemplateV1] audit write failed", e && e.message);
  }
}

exports.saveOrgTemplateV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });

    // PEAKOPS_AUTHZ_TEMPLATES_V1 (PR 119a)
    // Admin/owner only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[saveOrgTemplateV1] authz_denied", {
        fn: "saveOrgTemplateV1",
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
    console.log("[saveOrgTemplateV1] authz_ok", {
      fn: "saveOrgTemplateV1", orgId, uid: actorUid, role: actorRole,
    });

    // ── validation (all-or-nothing) ─────────────────────────────
    const archetype = trimStr(body.archetype).toLowerCase();
    if (!ARCHETYPE_ENUM.includes(archetype)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_archetype",
        detail: `archetype must be one of: ${ARCHETYPE_ENUM.join(", ")}`,
      });
    }

    // customerSlug: either empty (org-wide template) or a valid slug.
    // We accept body.customerLabel (human-readable) and derive the
    // slug server-side via toCustomerSlug so the doc id always matches
    // createIncidentV1's lookup convention.
    const customerLabel = trimStr(body.customerLabel);
    const customerSlugRaw = trimStr(body.customerSlug);
    let customerSlug = "";
    if (customerLabel) {
      // Prefer label-derived slug — keeps consistency with what
      // createIncidentV1 sees (it also derives via toCustomerSlug).
      customerSlug = toCustomerSlug(customerLabel);
      if (!customerSlug) {
        return j(res, 400, {
          ok: false,
          error: "invalid_customer_label",
          detail: "customerLabel produced an empty slug after sanitization",
        });
      }
    } else if (customerSlugRaw) {
      // Caller provided an explicit slug without a label — accept it
      // verbatim if shape-valid. This path supports raw API usage.
      if (!/^[a-z0-9-]{1,80}$/.test(customerSlugRaw)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_customer_slug",
          detail: "customerSlug must match ^[a-z0-9-]{1,80}$",
        });
      }
      customerSlug = customerSlugRaw;
    }

    // Compose templateKey identically to createIncidentV1's lookup
    // (line 354).
    const templateKey = customerSlug ? `${archetype}__${customerSlug}` : archetype;

    // Field sanitization (same caps as PR 107a / PR 118 truncation
    // limits — keeps downstream missing-items previews and PDF
    // rendering predictable).
    const requiredProof = sanitizeStringList(body.requiredProof, 50, 200);
    const optionalProof = sanitizeStringList(body.optionalProof, 50, 200);
    const acceptanceCriteria = sanitizeStringList(body.acceptanceCriteria, 30, 200);
    const acceptanceChecks = sanitizeChecksArray(body.acceptanceChecks);

    if (requiredProof.length === 0) {
      return j(res, 400, {
        ok: false,
        error: "empty_requiredProof",
        detail: "requiredProof must contain at least one entry",
      });
    }

    const changeNote = sanitizeProse(body.changeNote, 500);

    // ── version + write ─────────────────────────────────────────
    const db = getFirestore();
    const docRef = db.doc(`orgs/${orgId}/templates/${templateKey}`);
    const priorSnap = await docRef.get();
    const priorData = priorSnap.exists ? (priorSnap.data() || {}) : null;
    const priorVersion = priorData && Number.isFinite(Number(priorData.version)) && Number(priorData.version) > 0
      ? Number(priorData.version)
      : 0;
    const nextVersion = priorVersion + 1;

    const payload = {
      archetype,
      customerSlug,
      customerLabel,
      requiredProof,
      optionalProof,
      acceptanceCriteria,
      acceptanceChecks,
      version: nextVersion,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    };
    if (nextVersion === 1) {
      payload.createdAt = FieldValue.serverTimestamp();
      payload.createdBy = actorUid;
    }

    await docRef.set(payload, { merge: true });

    // Best-effort admin_audit append. Never fails the parent op.
    await writeAuditEntry(db, {
      type: "template_saved",
      orgId,
      actorUid,
      templateKey,
      archetype,
      customerSlug,
      customerLabel,
      version: nextVersion,
      changeNote,
    });

    console.log("[saveOrgTemplateV1] template_saved", {
      orgId, templateKey, version: nextVersion, actorUid,
    });

    return j(res, 200, {
      ok: true,
      orgId,
      templateKey,
      version: nextVersion,
      isCreate: nextVersion === 1,
    });
  } catch (e) {
    console.error("[saveOrgTemplateV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
