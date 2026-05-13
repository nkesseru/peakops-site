// PEAKOPS_ENTITLEMENT_V1 (2026-05-13)
//
// Premium-feature gate, separate from _authz.js.
//
// Responsibilities (surgical):
//   - Assert that orgs/{orgId}/billing/state grants the requested
//     featureKey (deny-by-default; missing doc means feature off).
//   - For features that produce new signed artifacts (e.g.
//     riskDefenseModule → exportIncidentPacketV1), also assert the
//     org status is not "suspended" or "cancelled".
//
// Explicit non-responsibilities:
//   - Membership and role checks remain in _authz.js. Call this
//     AFTER assertActorRole, not in place of it.
//   - This helper does NOT gate read paths, basic app usage, or
//     non-premium writes (notes, evidence, job creation, etc).
//     Suspended/cancelled orgs keep their existing read access via
//     the normal _authz.js path. Sprint 1 intentionally scopes the
//     status check to new-signed-packet-generation only.
//   - No Stripe. No webhooks. No metering.
//
// Wire mapping (call site responsibility):
//   - Throws HttpsError("failed-precondition") on either failure
//     mode → caller maps to HTTP 402 Payment Required.
//   - Throws HttpsError("invalid-argument") on caller-bug inputs
//     → caller maps to HTTP 400.
//   - True auth/permission failures (uid missing, not a member,
//     wrong role) continue to flow through _authz.js → HTTP 403,
//     and are intentionally NOT this module's concern.

"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const {
  getBillingState,
  STATUS_SUSPENDED,
  STATUS_CANCELLED,
} = require("./_billing");

/**
 * Stable, machine-readable reasons attached to the HttpsError details
 * payload. Callers should switch on these (not on error message
 * strings) when deciding which UpgradePrompt copy to render.
 */
const ENTITLEMENT_REASONS = Object.freeze({
  FEATURE_OFF:    "feature_off",       // entitlements[featureKey] !== true
  ORG_SUSPENDED:  "org_suspended",     // billing.status === "suspended"
  ORG_CANCELLED:  "org_cancelled",     // billing.status === "cancelled"
});

/**
 * Assert that an org is entitled to a specific premium feature AND
 * that its billing status permits new signed-artifact generation.
 *
 * Order of checks (most-common-failure first):
 *   1. featureKey must be present and === true in
 *      billing.entitlements. Missing billing/state doc maps to
 *      entitlements={} via _billing.getBillingState, so deny-by-
 *      default for unprovisioned orgs.
 *   2. billing.status must not be "suspended" or "cancelled".
 *      "active" (the default for missing docs) passes.
 *
 * @param {string} orgId
 * @param {string} featureKey
 * @returns {Promise<{
 *   billing: { status: string, plan: string, entitlements: Record<string, boolean>, exists: boolean },
 *   featureKey: string,
 * }>}
 *
 * @throws {HttpsError("invalid-argument")} on caller-bug inputs.
 * @throws {HttpsError("failed-precondition", message, { reason, featureKey, orgId })}
 *   on either feature-off or suspended/cancelled status. The
 *   `reason` field carries one of ENTITLEMENT_REASONS so the caller
 *   can render the right UpgradePrompt copy without sniffing strings.
 */
async function requireEntitlement(orgId, featureKey) {
  const cleanOrgId = String(orgId || "").trim();
  const cleanKey = String(featureKey || "").trim();
  if (!cleanOrgId) {
    throw new HttpsError("invalid-argument", "[entitlement] orgId required");
  }
  if (!cleanKey) {
    throw new HttpsError("invalid-argument", "[entitlement] featureKey required");
  }

  const billing = await getBillingState(cleanOrgId);

  // (1) Premium feature flag check. Deny-by-default for unprovisioned
  //     orgs per Sprint 1 product decision.
  if (billing.entitlements[cleanKey] !== true) {
    throw new HttpsError(
      "failed-precondition",
      `[entitlement] org "${cleanOrgId}" is not entitled to "${cleanKey}"`,
      {
        reason: ENTITLEMENT_REASONS.FEATURE_OFF,
        featureKey: cleanKey,
        orgId: cleanOrgId,
      },
    );
  }

  // (2) Status check — only blocks NEW signed-packet generation.
  //     Read paths and non-premium writes are intentionally not
  //     gated here; they continue through the normal _authz.js
  //     surface unchanged.
  if (billing.status === STATUS_SUSPENDED) {
    throw new HttpsError(
      "failed-precondition",
      `[entitlement] org "${cleanOrgId}" is suspended; new signed-packet generation is blocked`,
      {
        reason: ENTITLEMENT_REASONS.ORG_SUSPENDED,
        featureKey: cleanKey,
        orgId: cleanOrgId,
      },
    );
  }
  if (billing.status === STATUS_CANCELLED) {
    throw new HttpsError(
      "failed-precondition",
      `[entitlement] org "${cleanOrgId}" is cancelled; new signed-packet generation is blocked`,
      {
        reason: ENTITLEMENT_REASONS.ORG_CANCELLED,
        featureKey: cleanKey,
        orgId: cleanOrgId,
      },
    );
  }

  return { billing, featureKey: cleanKey };
}

/**
 * Map an entitlement HttpsError to an HTTP status code. Companion
 * to _authz.httpStatusFromAuthzError. Kept distinct so call sites
 * never accidentally collapse 402 (billing) into 403 (permission).
 *
 * @param {{ code?: string }} err
 * @returns {number}
 */
function httpStatusFromEntitlementError(err) {
  const code = (err && err.code) || "";
  if (code === "failed-precondition") return 402;
  if (code === "invalid-argument")    return 400;
  return 500;
}

module.exports = {
  requireEntitlement,
  httpStatusFromEntitlementError,
  ENTITLEMENT_REASONS,
};
