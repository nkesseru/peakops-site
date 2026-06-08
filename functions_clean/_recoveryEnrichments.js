// PEAKOPS_RECOVERY_ENRICHMENTS_V1 (PR 132a)
//
// Shared helpers for the Recovery Intelligence event-enrichment pass.
// Pure functions; no Firestore writes; no side effects.
//
// What this module owns:
//   1. hashCustomerLabel — stable, deterministic, irreversible hash
//      of a customer label. Used on RecoveryCase.hashedCustomerLabel
//      so future customer-pattern intelligence (PR 132c+) can count
//      rejections per customer WITHOUT storing PII.
//
//   2. durationSec — robust duration math over Firestore Timestamps,
//      ISO strings, and Date objects. Used by every audit-emitting
//      endpoint that wants to record timing for future intelligence.
//
//   3. countActionsByStatus — small reducer used by case_resolved
//      enrichment to record completion totals.
//
// Architecture lock (PR 132 planning):
//   - No aggregation here. This is event metadata.
//   - No new collections. Enrichments land on existing audit rows.
//   - No notifications, no UI, no AI inference.
//   - Hash is org-local: identical customer labels in different orgs
//     produce different hashes? NO — same string → same hash. That's
//     the point (so an org's repeat customer is detectable). Cross-
//     org correlation is prevented by aggregates being org-scoped,
//     not by hash mutation.

const crypto = require("crypto");

/**
 * Hash a customer label to a 32-character hex prefix of SHA-256.
 *
 *   "Comcast Restoration"   → "5e1f3a8c..."
 *   " comcast restoration " → "5e1f3a8c..."  (normalized)
 *   ""                      → null
 *   null/undefined          → null
 *
 * Normalization: trim + lowercase. Avoids "Comcast " vs "comcast"
 * being treated as different customers.
 *
 * @param {string} label
 * @returns {string | null}
 */
function hashCustomerLabel(label) {
  const normalized = String(label == null ? "" : label).trim().toLowerCase();
  if (!normalized) return null;
  // 32 hex chars = 128 bits = collision-safe within any single org's
  // expected customer set (~thousands at most). Full SHA-256 would
  // be 64 chars; truncation keeps query indexes lean.
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Convert a Firestore Timestamp / ISO string / Date / null to ms epoch.
 * @returns {number | null}
 */
function tsToMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object") {
    if (typeof v.toDate === "function") {
      try { return v.toDate().getTime(); } catch { /* fallthrough */ }
    }
    if (typeof v._seconds === "number") {
      return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
    }
    if (typeof v.seconds === "number") {
      return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
  }
  return null;
}

/**
 * Duration between two time-ish values in whole seconds. Returns null
 * when either side can't be coerced. Floors at 0 so a clock skew of
 * a few ms on read-after-write doesn't produce negative durations.
 *
 * @param {*} fromV
 * @param {*} toV
 * @returns {number | null}
 */
function durationSec(fromV, toV) {
  const fromMs = tsToMs(fromV);
  const toMs = tsToMs(toV);
  if (fromMs == null || toMs == null) return null;
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

/**
 * Reduce an array of action docs (each with `status` field) to the
 * counts we surface on case_resolved enrichment.
 *
 * @param {Array<{ status?: string } | { data?: () => { status?: string }, get?: () => any }>} actions
 * @returns {{ total: number, open: number, in_progress: number, blocked: number, done: number, skipped: number }}
 */
function countActionsByStatus(actions) {
  const out = { total: 0, open: 0, in_progress: 0, blocked: 0, done: 0, skipped: 0 };
  for (const a of (Array.isArray(actions) ? actions : [])) {
    out.total += 1;
    const data = typeof a?.data === "function" ? (a.data() || {}) : a;
    const s = String(data?.status || "").trim().toLowerCase();
    if (s in out) out[s] += 1;
  }
  return out;
}

module.exports = {
  hashCustomerLabel,
  durationSec,
  tsToMs,
  countActionsByStatus,
};
