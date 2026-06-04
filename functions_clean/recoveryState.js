// PEAKOPS_RECOVERY_STATE_V1 (PR 127a)
//
// Recovery Case + Recovery Action state machine and shared taxonomies.
// Mirrors the discipline of incidentState.js (PR 126a/c) — single
// source of truth for transitions and enum membership.
//
// The Revenue Protection & Recovery model treats every customer
// rejection as a tracked workflow with revenue attached. Recovery
// Cases are the primary object; Recovery Actions are the granular
// work items inside a case. PacketVersions are denormalized
// references to the customer-review audit chain (PR 126).
//
// Wedge guards encoded here:
//   - No "customer entity" concept (that would slide toward CRM)
//   - No SLA enforcement (informational targets only)
//   - No invoice / billing concepts (revenueAtRisk is a number, not
//     a relationship)
//   - Terminal states are truly terminal (no reopen path)

// ── Case statuses (9) ────────────────────────────────────────────
const RECOVERY_STATUS = Object.freeze({
  OPEN: "open",
  TRIAGED: "triaged",
  IN_PROGRESS: "in_progress",
  AWAITING_CUSTOMER: "awaiting_customer",
  ESCALATED: "escalated",
  RECOVERED: "recovered",                  // terminal
  PARTIAL_RECOVERY: "partial_recovery",    // terminal
  ABANDONED: "abandoned",                  // terminal
  EXPIRED: "expired",                      // terminal (auto by cron in Phase 1)
});

const TERMINAL_STATUSES = Object.freeze(new Set([
  RECOVERY_STATUS.RECOVERED,
  RECOVERY_STATUS.PARTIAL_RECOVERY,
  RECOVERY_STATUS.ABANDONED,
  RECOVERY_STATUS.EXPIRED,
]));

const ALL_STATUSES = Object.freeze(new Set(Object.values(RECOVERY_STATUS)));

// ── Priority tiers (4) — PR 127a #4 ──────────────────────────────
const RECOVERY_PRIORITY = Object.freeze(["low", "medium", "high", "critical"]);
const RECOVERY_PRIORITY_SET = new Set(RECOVERY_PRIORITY);

// ── Source enum (2) — PR 127a #5 ─────────────────────────────────
const RECOVERY_SOURCE = Object.freeze(["customer_rejected", "internal_qc"]);
const RECOVERY_SOURCE_SET = new Set(RECOVERY_SOURCE);

// ── Revenue type (3) — PR 127a #6 ────────────────────────────────
const REVENUE_TYPE = Object.freeze(["actual", "estimated", "unknown"]);
const REVENUE_TYPE_SET = new Set(REVENUE_TYPE);

// ── Cause taxonomy (11) — most-specific-first ────────────────────
const RECOVERY_CAUSE_PRIMARY = Object.freeze([
  "missing_required_proof",
  "proof_quality_insufficient",
  "wrong_proof_uploaded",
  "documentation_error",
  "customer_changed_requirements",
  "scope_dispute",
  "compliance_failure",
  "unclear_customer_feedback",
  "internal_qc_caught",
  // PR 128a — telecom blind spot. OTDR traces, loss measurements,
  // splice reports are first-class proof items distinct from generic
  // documentation. Promoted from the catch-all "missing_required_proof"
  // because the recovery action chain differs (Provide Test Results vs
  // Capture Missing Proof).
  "missing_test_result",
  "other",
]);
const RECOVERY_CAUSE_PRIMARY_SET = new Set(RECOVERY_CAUSE_PRIMARY);

// ── Owner roles (4) ──────────────────────────────────────────────
const OWNER_ROLES = Object.freeze([
  "coordinator",
  "supervisor",
  "field_lead",
  "manager",
]);
const OWNER_ROLES_SET = new Set(OWNER_ROLES);

// ── Action types (10) ────────────────────────────────────────────
const RECOVERY_ACTION_TYPES = Object.freeze([
  "recapture_proof",
  "clarify_with_customer",
  "internal_qc_check",
  "re_submit_to_customer",
  "escalate_internal",
  "escalate_to_customer",
  "documentation_fix",
  "field_revisit",
  // PR 127a3 — telecom / fiber recovery commonly requires test
  // results (OTDR traces, loss measurements, splice reports) that
  // are distinct from generic documentation. Adding as a first-class
  // action type so the UI surfaces it as "Provide Test Results"
  // instead of forcing operators to overload "Upload Missing
  // Documentation."
  "provide_test_results",
  "other",
]);
const RECOVERY_ACTION_TYPES_SET = new Set(RECOVERY_ACTION_TYPES);

// ── Action statuses (5) ──────────────────────────────────────────
const RECOVERY_ACTION_STATUS = Object.freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  DONE: "done",
  SKIPPED: "skipped",
});
const RECOVERY_ACTION_STATUS_SET = new Set(Object.values(RECOVERY_ACTION_STATUS));

// ── Helpers ──────────────────────────────────────────────────────

function normalizeRecoveryStatus(status) {
  const raw = String(status || "").trim().toLowerCase().replace(/\s+/g, "_");
  return ALL_STATUSES.has(raw) ? raw : RECOVERY_STATUS.OPEN;
}

/**
 * Decide whether a status transition is allowed.
 *
 * Terminal states never transition out (only to themselves, for
 * idempotency on retries). The rest of the matrix is encoded in
 * the switch below. Mirrors the spec in PR 127a planning doc.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransitionRecovery(from, to) {
  const f = normalizeRecoveryStatus(from);
  const t = normalizeRecoveryStatus(to);

  if (TERMINAL_STATUSES.has(f)) return f === t;

  switch (f) {
    case RECOVERY_STATUS.OPEN:
      return [
        RECOVERY_STATUS.OPEN,
        RECOVERY_STATUS.TRIAGED,
        RECOVERY_STATUS.ABANDONED,
      ].includes(t);

    case RECOVERY_STATUS.TRIAGED:
      return [
        RECOVERY_STATUS.TRIAGED,
        RECOVERY_STATUS.IN_PROGRESS,
        RECOVERY_STATUS.ESCALATED,
        RECOVERY_STATUS.ABANDONED,
      ].includes(t);

    case RECOVERY_STATUS.IN_PROGRESS:
      return [
        RECOVERY_STATUS.IN_PROGRESS,
        RECOVERY_STATUS.AWAITING_CUSTOMER,
        RECOVERY_STATUS.ESCALATED,
        RECOVERY_STATUS.RECOVERED,
        RECOVERY_STATUS.PARTIAL_RECOVERY,
        RECOVERY_STATUS.ABANDONED,
      ].includes(t);

    case RECOVERY_STATUS.AWAITING_CUSTOMER:
      return [
        RECOVERY_STATUS.AWAITING_CUSTOMER,
        RECOVERY_STATUS.IN_PROGRESS,
        RECOVERY_STATUS.RECOVERED,
        RECOVERY_STATUS.ESCALATED,
        RECOVERY_STATUS.ABANDONED,
      ].includes(t);

    case RECOVERY_STATUS.ESCALATED:
      return [
        RECOVERY_STATUS.ESCALATED,
        RECOVERY_STATUS.IN_PROGRESS,
        RECOVERY_STATUS.RECOVERED,
        RECOVERY_STATUS.PARTIAL_RECOVERY,
        RECOVERY_STATUS.ABANDONED,
      ].includes(t);

    default:
      return false;
  }
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(normalizeRecoveryStatus(status));
}

// ── Deterministic case id for auto-create path ────────────────────
// Two near-simultaneous rejections on the same incident token
// would produce the same id (idempotent on retry). For different
// tokens, they get different ids — but in practice an incident
// only has one open case at a time, so the lookup-then-create
// transaction reuses the existing case rather than minting a new id.
function deterministicCaseId(incidentId, tokenHashPrefix) {
  const inc = String(incidentId || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  const tok = String(tokenHashPrefix || "").trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  return `case_${inc}_${tok || "manual"}`;
}

module.exports = {
  // Statuses
  RECOVERY_STATUS,
  TERMINAL_STATUSES,
  // Enums
  RECOVERY_PRIORITY,
  RECOVERY_PRIORITY_SET,
  RECOVERY_SOURCE,
  RECOVERY_SOURCE_SET,
  REVENUE_TYPE,
  REVENUE_TYPE_SET,
  RECOVERY_CAUSE_PRIMARY,
  RECOVERY_CAUSE_PRIMARY_SET,
  OWNER_ROLES,
  OWNER_ROLES_SET,
  RECOVERY_ACTION_TYPES,
  RECOVERY_ACTION_TYPES_SET,
  RECOVERY_ACTION_STATUS,
  RECOVERY_ACTION_STATUS_SET,
  // Functions
  normalizeRecoveryStatus,
  canTransitionRecovery,
  isTerminal,
  deterministicCaseId,
};
