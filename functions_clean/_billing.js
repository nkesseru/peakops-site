// PEAKOPS_BILLING_STATE_V1 (2026-05-13)
//
// Storage helper for the org-level billing state doc. One doc per
// org at:
//
//   orgs/{orgId}/billing/state
//
// Schema:
//   {
//     status:       "active" | "suspended" | "cancelled",
//     plan:         string,                              // "free" | "pro" | "enterprise" | custom label
//     entitlements: { [featureKey: string]: boolean },   // explicit per-feature allow-list
//     lastUpdatedAt:    Firestore.Timestamp,                 // server-stamped on every write
//     lastUpdatedBy:    string,                              // uid of internal admin who toggled
//   }
//
// Deny-by-default missing-doc semantics:
//   When the doc does not exist, getBillingState returns the
//   DEFAULT_BILLING_STATE below — status="active" (so missing doc
//   doesn't accidentally lock the org out of read paths) but
//   entitlements={} (so every premium feature is OFF until an
//   internal admin grants it via the /admin/orgs/{orgId}/billing
//   UI).
//
// What this module deliberately does NOT do:
//   - No Stripe integration.
//   - No webhook handlers.
//   - No metering. No automatic plan changes.
//   - No write surfaces beyond setBillingState (which is intended
//     for the internal admin route to call via Admin SDK).
//
// All reads/writes flow through Admin SDK and therefore bypass
// firestore.rules. The client never reads or writes billing state
// directly — Firestore rules continue to deny client access by
// default (the existing orgs/{orgId}/{...} sub-rules don't include
// a /billing/{document=**} carve-out).

"use strict";

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const BILLING_STATE_PATH = (orgId) => `orgs/${orgId}/billing/state`;

/** Org statuses. */
const STATUS_ACTIVE     = "active";
const STATUS_SUSPENDED  = "suspended";
const STATUS_CANCELLED  = "cancelled";

const VALID_STATUSES = new Set([STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_CANCELLED]);

/**
 * Feature keys that requireEntitlement understands. Adding a new
 * gated feature: extend this list and add the matching toggle row
 * to the /admin/orgs/{orgId}/billing UI. The constant is exported
 * so the admin route and entitlement helper share one source of
 * truth — typos in featureKey become a render-time miss in the
 * admin UI rather than a silent runtime deny.
 */
const FEATURE_KEYS = Object.freeze([
  "riskDefenseModule",
  "api",
  "sso",
  "whiteLabel",
]);

/**
 * Default state returned when no billing/state doc exists. status
 * defaults to "active" (do not lock orgs out of basic operations
 * for missing-doc reasons) and entitlements defaults to {} (every
 * premium feature is OFF until explicitly granted).
 */
const DEFAULT_BILLING_STATE = Object.freeze({
  status: STATUS_ACTIVE,
  plan: "free",
  entitlements: Object.freeze({}),
  lastUpdatedAt: null,
  lastUpdatedBy: "",
});

/**
 * Read the billing state for an org. Returns the default state
 * (deny-by-default for entitlements) when the doc is missing.
 * Never throws on missing doc — that's not an error, it's the
 * legacy / unprovisioned state.
 *
 * @param {string} orgId
 * @returns {Promise<{
 *   status: string,
 *   plan: string,
 *   entitlements: Record<string, boolean>,
 *   lastUpdatedAt: FirebaseFirestore.Timestamp | null,
 *   lastUpdatedBy: string,
 *   exists: boolean,
 * }>}
 */
async function getBillingState(orgId) {
  const cleanOrgId = String(orgId || "").trim();
  if (!cleanOrgId) {
    return { ...DEFAULT_BILLING_STATE, entitlements: {}, exists: false };
  }
  const snap = await getFirestore().doc(BILLING_STATE_PATH(cleanOrgId)).get();
  if (!snap.exists) {
    return { ...DEFAULT_BILLING_STATE, entitlements: {}, exists: false };
  }
  const data = snap.data() || {};
  const status = typeof data.status === "string" && VALID_STATUSES.has(data.status)
    ? data.status
    : STATUS_ACTIVE;
  const plan = typeof data.plan === "string" && data.plan
    ? data.plan
    : "free";
  const entitlements = (data.entitlements && typeof data.entitlements === "object")
    ? Object.fromEntries(
        Object.entries(data.entitlements).map(([k, v]) => [String(k), v === true])
      )
    : {};
  return {
    status,
    plan,
    entitlements,
    lastUpdatedAt: data.lastUpdatedAt || null,
    lastUpdatedBy: String(data.lastUpdatedBy || ""),
    exists: true,
  };
}

/**
 * Write (merge) the billing state for an org. Validates the patch
 * shape; rejects unknown statuses and unknown feature keys to keep
 * the schema honest. Stamps lastUpdatedAt + lastUpdatedBy on every write.
 *
 * @param {string} orgId
 * @param {{
 *   status?: string,
 *   plan?: string,
 *   entitlements?: Record<string, boolean>,
 * }} patch
 * @param {string} actorUid  uid of internal admin making the change
 * @returns {Promise<void>}
 */
async function setBillingState(orgId, patch, actorUid) {
  const cleanOrgId = String(orgId || "").trim();
  if (!cleanOrgId) throw new Error("[billing] orgId required");
  const update = {
    lastUpdatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: String(actorUid || "").trim(),
  };
  if (patch && typeof patch.status === "string") {
    const s = patch.status.trim().toLowerCase();
    if (!VALID_STATUSES.has(s)) {
      throw new Error(`[billing] unknown status "${s}"`);
    }
    update.status = s;
  }
  if (patch && typeof patch.plan === "string") {
    update.plan = patch.plan.trim();
  }
  if (patch && patch.entitlements && typeof patch.entitlements === "object") {
    const sanitized = {};
    for (const [k, v] of Object.entries(patch.entitlements)) {
      const key = String(k).trim();
      if (!FEATURE_KEYS.includes(key)) {
        throw new Error(`[billing] unknown featureKey "${key}"`);
      }
      sanitized[key] = v === true;
    }
    update.entitlements = sanitized;
  }
  await getFirestore().doc(BILLING_STATE_PATH(cleanOrgId)).set(update, { merge: true });
}

module.exports = {
  BILLING_STATE_PATH,
  STATUS_ACTIVE,
  STATUS_SUSPENDED,
  STATUS_CANCELLED,
  VALID_STATUSES,
  FEATURE_KEYS,
  DEFAULT_BILLING_STATE,
  getBillingState,
  setBillingState,
};
