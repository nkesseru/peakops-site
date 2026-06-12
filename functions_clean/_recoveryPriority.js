// PEAKOPS_RECOVERY_PRIORITY_V1 (PR 127a2)
//
// System-derived priority for Recovery Cases. Per PR 127a2 planning,
// priority is no longer operator-selected — it's computed from
// revenueAtRisk.amount + daysOpen (aging) on every read.
//
// Thresholds (approved 2026-06-03):
//   critical: amount ≥ $50,000  OR  daysOpen ≥ 30
//   high:     amount ≥ $20,000  OR  daysOpen ≥ 14
//   medium:   amount ≥  $5,000  OR  daysOpen ≥  7
//   low:      otherwise
//
// When the amount is unknown OR the amount type is "unknown", the
// rule falls back to aging-only thresholds (same numeric cutoffs).
// Operators can fill in the amount later to re-derive.
//
// What this helper does NOT do:
//   - Persist the value (read-derived only)
//   - Hit Firestore (pure compute)
//   - Care about case status (terminal cases also report a derived
//     priority, surfaced for historical analysis)
//
// Phase 2: thresholds become org-level config. For MVP, hardcoded.

const TIER_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

const AMOUNT_THRESHOLDS = Object.freeze({
  critical: 50000,
  high: 20000,
  medium: 5000,
});

const AGING_THRESHOLDS = Object.freeze({
  critical: 30,
  high: 14,
  medium: 7,
});

function tierFromAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "low";
  if (n >= AMOUNT_THRESHOLDS.critical) return "critical";
  if (n >= AMOUNT_THRESHOLDS.high) return "high";
  if (n >= AMOUNT_THRESHOLDS.medium) return "medium";
  return "low";
}

function tierFromAging(daysOpen) {
  const d = Number(daysOpen);
  if (!Number.isFinite(d) || d < 0) return "low";
  if (d >= AGING_THRESHOLDS.critical) return "critical";
  if (d >= AGING_THRESHOLDS.high) return "high";
  if (d >= AGING_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * Derive recovery case priority.
 *
 * @param {object} args
 * @param {number} [args.amount]           — revenueAtRisk.amount (USD)
 * @param {number} [args.daysOpen]         — aging in days
 * @param {string} [args.amountType]       — "actual" | "estimated" | "unknown"
 * @returns {"low" | "medium" | "high" | "critical"}
 */
function derivePriority({ amount, daysOpen, amountType }) {
  const aging = tierFromAging(daysOpen);

  // Unknown amount → aging-only signal.
  if (amountType === "unknown" || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return aging;
  }

  const fromAmount = tierFromAmount(amount);
  return TIER_RANK[fromAmount] >= TIER_RANK[aging] ? fromAmount : aging;
}

/**
 * Compute daysOpen given an openedAt timestamp (Firestore Timestamp,
 * Date, ISO string, or epoch ms).
 *
 * @param {*} openedAt
 * @param {Date} [now]  override for tests
 * @returns {number}
 */
function daysOpenSince(openedAt, now = new Date()) {
  if (!openedAt) return 0;
  let openedDate;
  if (openedAt && typeof openedAt.toDate === "function") {
    openedDate = openedAt.toDate();
  } else if (openedAt instanceof Date) {
    openedDate = openedAt;
  } else if (typeof openedAt === "number") {
    openedDate = new Date(openedAt);
  } else {
    openedDate = new Date(String(openedAt));
  }
  if (Number.isNaN(openedDate.getTime())) return 0;
  const diffMs = now.getTime() - openedDate.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

module.exports = {
  derivePriority,
  daysOpenSince,
  AMOUNT_THRESHOLDS,
  AGING_THRESHOLDS,
  TIER_RANK,
};
