// PEAKOPS_AUTHZ_V1 (2026-05-06)
//
// Shared authorization helper for V1 callables. Implements the first
// link of the invariant chain from
// docs/MULTI_ORG_RELATIONSHIP_MODEL.md § Non-Negotiable Invariants:
//
//   "Every access decision is traceable as a chain:
//    user → membership → org → relationship → share scope → resource."
//
// This module owns the user → membership → org segment. Relationship
// and share-scope assertions land in later phases (Phase 4 / 5).
//
// Behavior:
//   - assertActorMember(orgId, uid)
//       fails closed when uid is missing, orgId is missing, the org
//       doc is missing, the membership doc is missing, or the
//       membership status is not "active".
//       Returns { membership, org } on success so callers do not need
//       to re-read those docs.
//
// Errors are firebase-functions HttpsError with stable codes so
// callers can map to client-facing copy without sniffing strings:
//   - "unauthenticated"   — missing uid
//   - "invalid-argument"  — missing orgId
//   - "not-found"         — org doc absent
//   - "permission-denied" — no membership, or membership not active
//
// Backwards-compatibility note (foundation phase):
//   Some pre-Phase-2 membership docs do not yet carry a `status` field.
//   We treat an undefined status as "active" so existing field/admin
//   sessions don't break the moment a callable adopts this helper.
//   Phase 2 (membership rollout) tightens this to strict-explicit and
//   the backfill will guarantee every membership has status set.

const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Assert the actor (uid) is an active member of the org (orgId).
 *
 * @param {string} orgId
 * @param {string} uid
 * @returns {Promise<{
 *   membership: { uid: string, role?: string, status?: string, [k: string]: any },
 *   org: { orgId: string, [k: string]: any }
 * }>}
 *
 * @throws {HttpsError} on any failure. Caller should let the error
 *   propagate to firebase-functions, which maps it to the appropriate
 *   wire response.
 */
async function assertActorMember(orgId, uid) {
  const cleanUid = String(uid || "").trim();
  if (!cleanUid) {
    throw new HttpsError("unauthenticated", "[authz] missing uid");
  }

  const cleanOrgId = String(orgId || "").trim();
  if (!cleanOrgId) {
    throw new HttpsError("invalid-argument", "[authz] missing orgId");
  }

  const db = getFirestore();
  const orgRef = db.doc(`orgs/${cleanOrgId}`);
  const memberRef = db.doc(`orgs/${cleanOrgId}/members/${cleanUid}`);

  const [orgSnap, memberSnap] = await Promise.all([
    orgRef.get(),
    memberRef.get(),
  ]);

  if (!orgSnap.exists) {
    throw new HttpsError(
      "not-found",
      `[authz] org not found: ${cleanOrgId}`,
    );
  }

  if (!memberSnap.exists) {
    throw new HttpsError(
      "permission-denied",
      `[authz] uid ${cleanUid} is not a member of ${cleanOrgId}`,
    );
  }

  const membership = memberSnap.data() || {};

  // See backwards-compatibility note in the file header.
  const rawStatus = membership.status;
  const status =
    typeof rawStatus === "string" && rawStatus.trim()
      ? rawStatus.trim().toLowerCase()
      : "active";

  if (status !== "active") {
    throw new HttpsError(
      "permission-denied",
      `[authz] membership status is "${status}" for uid ${cleanUid} in ${cleanOrgId}`,
    );
  }

  return {
    membership: { uid: cleanUid, ...membership },
    org: { orgId: cleanOrgId, ...(orgSnap.data() || {}) },
  };
}

/**
 * Map an HttpsError thrown by assertActorMember to an HTTP status code,
 * for callers that use onRequest (not onCall) and need to translate
 * the canonical Firebase error code into a wire status. onCall does
 * this automatically; onRequest does not.
 *
 * @param {{ code?: string }} err
 * @returns {number}
 */
function httpStatusFromAuthzError(err) {
  const code = (err && err.code) || "permission-denied";
  switch (code) {
    case "unauthenticated":   return 401;
    case "invalid-argument":  return 400;
    case "not-found":         return 404;
    case "permission-denied": return 403;
    default:                  return 500;
  }
}

// ─── PEAKOPS_AUTHZ_ROLE_V1 (2026-05-06) ────────────────────────────
//
// Role-aware authorization helpers. Builds on assertActorMember to
// enforce the role-allow-list rules defined in Phase 1 Slice 4 of
// docs/MULTI_ORG_IMPLEMENTATION_PLAN.md:
//
//   admin       : all org actions
//   supervisor  : approve / review / close / finalize / report
//   field       : create / submit field work, photos, notes, assigned
//                 job work
//   viewer      : read-only only
//
// "owner" sits above admin in the architecture model and is therefore
// always included alongside admin in every allow-list. Owner is not
// special-cased inside assertActorRole — it appears explicitly in the
// constants below so the audit log shows the real allow-list, not
// hidden behavior.
//
// Capability helpers are pure boolean predicates (no IO); they are
// safe to use in conditional UI rendering or business-rule branches
// without paying for a Firestore round-trip. The IO-bound enforcer is
// assertActorRole, which loads the membership doc via
// assertActorMember and rejects on role mismatch with a stable
// HttpsError("permission-denied").

function _normRole(role) {
  return String(role || "").trim().toLowerCase();
}

function isAdmin(role) {
  const r = _normRole(role);
  return r === "admin" || r === "owner";
}

function isSupervisor(role) {
  const r = _normRole(role);
  return r === "supervisor" || r === "admin" || r === "owner";
}

function canApprove(role) {
  // Approve/review/close/finalize: supervisor or above.
  return isSupervisor(role);
}

function canCreateJob(role) {
  // Per Slice 4 default: admin/supervisor. If product later confirms
  // field-created jobs are a real flow, broaden to canSubmitFieldWork.
  return isSupervisor(role);
}

function canSubmitFieldWork(role) {
  const r = _normRole(role);
  return r === "field" || r === "supervisor" || r === "admin" || r === "owner";
}

function canGenerateReport(role) {
  // Report generation / packet export: supervisor or above.
  return isSupervisor(role);
}

// Allow-lists for the common gates. Exported so call sites can name
// the intent declaratively at the gate, and so the audit log captures
// the real list rather than a synthesized one. Owner is always
// included — it never makes sense to grant "admin" without "owner".
const ROLES_ADMIN_ONLY        = ["owner", "admin"];
const ROLES_APPROVE           = ["owner", "admin", "supervisor"];
const ROLES_CREATE_JOB        = ["owner", "admin", "supervisor"];
const ROLES_GENERATE_REPORT   = ["owner", "admin", "supervisor"];
const ROLES_FIELD_WORK        = ["owner", "admin", "supervisor", "field"];
// Read access — every active org member, including viewer. Used by
// assertActorCanReadOrg in Slice 6.
const ROLES_ALL_MEMBERS       = ["owner", "admin", "supervisor", "field", "viewer"];

/**
 * Assert the actor (uid) is an active member of the org (orgId) AND
 * holds one of the roles in `allowedRoles`. Composes assertActorMember
 * with a role-allow-list check.
 *
 * On role mismatch the thrown HttpsError carries
 * details: { role, allowedRoles } so the calling function can log the
 * real role server-side without leaking it to the wire — the wire
 * response uses only the canonical Firebase error code.
 *
 * @param {string} orgId
 * @param {string} uid
 * @param {ReadonlyArray<string>} allowedRoles
 * @returns {Promise<{
 *   membership: { uid: string, role?: string, status?: string, [k: string]: any },
 *   org: { orgId: string, [k: string]: any }
 * }>}
 *
 * @throws {HttpsError} on any failure path from assertActorMember, or
 *   "permission-denied" with { role, allowedRoles } details when the
 *   member's role is not in the allow-list.
 */
async function assertActorRole(orgId, uid, allowedRoles) {
  const gate = await assertActorMember(orgId, uid);

  const rawRole = gate.membership && gate.membership.role;
  const role = _normRole(rawRole);
  const allowed = (Array.isArray(allowedRoles) ? allowedRoles : [])
    .map(_normRole)
    .filter(Boolean);

  if (allowed.length === 0) {
    // Caller bug: an empty allow-list would otherwise reject everyone
    // with a confusing message. Surface it loudly.
    throw new HttpsError(
      "permission-denied",
      "[authz] empty allowedRoles passed to assertActorRole — caller bug",
      { role, allowedRoles: [] },
    );
  }

  if (!allowed.includes(role)) {
    throw new HttpsError(
      "permission-denied",
      `[authz] role "${role}" not in allow-list [${allowed.join(",")}] for uid ${uid} in ${orgId}`,
      { role, allowedRoles: allowed },
    );
  }

  return gate;
}

/**
 * PEAKOPS_AUTHZ_READ_V1 (2026-05-06)
 * Read-side gate for Phase 1 Slice 6: every active member of the org
 * may read its operational data, including the viewer role. Composes
 * cleanly with assertActorRole — this is a thin wrapper that names
 * the intent ("read") rather than a separate code path.
 *
 * @param {string} orgId
 * @param {string} uid
 * @returns {Promise<{
 *   membership: { uid: string, role?: string, status?: string, [k: string]: any },
 *   org: { orgId: string, [k: string]: any }
 * }>}
 *
 * @throws {HttpsError} on the same conditions as assertActorRole.
 */
async function assertActorCanReadOrg(orgId, uid) {
  return assertActorRole(orgId, uid, ROLES_ALL_MEMBERS);
}

/**
 * PEAKOPS_TENANT_ISOLATION_V1 (Chunk 1: Trust Foundation, 2026-06-22)
 *
 * Defense-in-depth guard that asserts the resolved incident actually
 * belongs to the caller's org. Required wherever the legacy top-level
 * `incidents/{incidentId}` path is consulted as a fallback to the
 * canonical `orgs/{orgId}/incidents/{incidentId}`: without this check,
 * an entitled member of org A could read/mutate/export org B's incident
 * by passing { orgId: "A", incidentId: "<B's id>" }.
 *
 * Returns 404 (not 403) on mismatch so the response is indistinguishable
 * from a nonexistent incident and does not confirm the foreign incident's
 * existence to the caller.
 *
 * Legacy compatibility: returns `match: true` when the incident doc has
 * no orgId field (very old records pre-dating multi-tenant rollout).
 * Modern writes always populate orgId, so this branch will quiesce over
 * time. Callers may upgrade to strict-mode (false on missing orgId) once
 * a verified-clean audit confirms the legacy bucket is empty.
 *
 * @param {FirebaseFirestore.DocumentSnapshot} incSnap   Snapshot of the
 *                                                       incident doc.
 * @param {string} callerOrgId                           The orgId the
 *                                                       caller is acting under.
 * @param {object} [ctx]                                 Optional logging
 *                                                       context.
 * @param {string} [ctx.fn]
 * @param {string} [ctx.incidentId]
 * @param {string} [ctx.actorUid]
 *
 * @returns {{ match: boolean, incidentOrgId: string|null }}
 */
function assertIncidentBelongsToOrg(incSnap, callerOrgId, ctx) {
  const callerOrg = String(callerOrgId || "").trim();
  if (!incSnap || typeof incSnap.exists !== "boolean") {
    return { match: false, incidentOrgId: null };
  }
  if (!incSnap.exists) {
    return { match: false, incidentOrgId: null };
  }
  const data = incSnap.data() || {};
  const incidentOrgId = String(data.orgId || "").trim() || null;

  // Legacy records without an orgId field are grandfathered. Once the
  // post-pilot audit confirms no such records remain, flip this to
  // `return { match: false }` to deny ambiguity.
  if (!incidentOrgId) {
    return { match: true, incidentOrgId: null };
  }

  if (incidentOrgId !== callerOrg) {
    // Log structured event for security-trail review. Never include the
    // foreign incident's contents — only its orgId, which the caller can't
    // see in the response.
    // eslint-disable-next-line no-console
    console.warn("[PEAKOPS_TENANT_ISOLATION_V1] tenant_mismatch", {
      fn: (ctx && ctx.fn) || "unknown",
      callerOrgId: callerOrg,
      incidentDocOrgId: incidentOrgId,
      incidentId: (ctx && ctx.incidentId) || incSnap.id || null,
      uid: (ctx && ctx.actorUid) || null,
    });
    return { match: false, incidentOrgId };
  }
  return { match: true, incidentOrgId };
}

module.exports = {
  assertActorMember,
  assertActorRole,
  assertActorCanReadOrg,
  assertIncidentBelongsToOrg,
  httpStatusFromAuthzError,
  // Role identity predicates
  isAdmin,
  isSupervisor,
  // Capability predicates
  canApprove,
  canCreateJob,
  canSubmitFieldWork,
  canGenerateReport,
  // Allow-list constants
  ROLES_ADMIN_ONLY,
  ROLES_APPROVE,
  ROLES_CREATE_JOB,
  ROLES_GENERATE_REPORT,
  ROLES_FIELD_WORK,
  ROLES_ALL_MEMBERS,
};
