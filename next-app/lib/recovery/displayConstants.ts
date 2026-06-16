// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// All display strings + color/tier mappings approved 2026-06-03.
// Keep mappings explicit; never auto-translate or fuzzy-match.
// New enum values require a code-review-gated entry here.
//
// WEDGE: copy strings here use Revenue Protection language, never
// ticket-software language ("task", "ticket", "queue item", etc.).

import type {
  RecoveryStatus,
  RecoveryPriority,
  RecoveryActionType,
  RecoveryActionStatus,
  RecoveryCausePrimary,
  RecoverySource,
  RevenueType,
  OwnerRole,
} from "./types";

// ── Status display ─────────────────────────────────────────────────

export const STATUS_DISPLAY: Record<RecoveryStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  // PR 129a — auto-entered when all actions are done; drives the
  // Resubmit Packet CTA in the operator UI.
  ready_to_resubmit: "Ready to resubmit",
  // PR 129a — resubmission link minted; customer hasn't responded yet.
  awaiting_customer: "Awaiting customer",
  escalated: "Escalated",
  recovered: "Recovered",
  partial_recovery: "Partial recovery",
  abandoned: "Abandoned",
  expired: "Expired",
  // PR 129a — legacy label for pre-PR-129a cases; new writes never use this.
  triaged: "Triaged (legacy)",
};

export const TERMINAL_STATUSES = new Set<RecoveryStatus>([
  "recovered",
  "partial_recovery",
  "abandoned",
  "expired",
]);

// ── Priority display + colors (PR 127b approved palette) ───────────

export const PRIORITY_DISPLAY: Record<RecoveryPriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Tailwind utility strings — applied to a single pill element.
// Order matters for visual scanning: critical/red catches the eye,
// low/gray fades.
export const PRIORITY_PILL_CLASS: Record<RecoveryPriority, string> = {
  critical: "bg-red-500/15 text-red-300 border-red-400/30",
  high: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  medium: "bg-yellow-500/15 text-yellow-200 border-yellow-400/30",
  low: "bg-gray-500/15 text-gray-300 border-gray-400/30",
};

export const PRIORITY_DOT_CLASS: Record<RecoveryPriority, string> = {
  critical: "bg-red-400",
  high: "bg-amber-400",
  medium: "bg-yellow-300",
  low: "bg-gray-400",
};

export const PRIORITY_RANK: Record<RecoveryPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Status pill colors ────────────────────────────────────────────

export const STATUS_PILL_CLASS: Record<RecoveryStatus, string> = {
  open: "bg-gray-500/15 text-gray-200 border-gray-400/30",
  in_progress: "bg-blue-500/15 text-blue-200 border-blue-400/30",
  // PR 129a — green: actively eligible to resubmit (the operator's
  // bright signal to act). Distinct from awaiting (waiting).
  ready_to_resubmit: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  awaiting_customer: "bg-violet-500/15 text-violet-200 border-violet-400/30",
  escalated: "bg-orange-500/15 text-orange-200 border-orange-400/30",
  recovered: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  partial_recovery: "bg-teal-500/15 text-teal-200 border-teal-400/30",
  abandoned: "bg-gray-500/10 text-gray-400 border-gray-500/20",
  expired: "bg-gray-500/10 text-gray-400 border-gray-500/20",
  // PR 129a — legacy pill class (matches old triaged styling).
  triaged: "bg-sky-500/15 text-sky-200 border-sky-400/30",
};

// ── Recovery Action type display (PR 127a3 includes 10th type) ───

export const ACTION_TYPE_DISPLAY: Record<RecoveryActionType, string> = {
  recapture_proof: "Re-shoot photos",
  clarify_with_customer: "Ask the customer",
  internal_qc_check: "Supervisor re-review",
  re_submit_to_customer: "Send updated packet",
  documentation_fix: "Fix the document",
  field_revisit: "Send crew back to site",
  escalate_internal: "Escalate internally",
  escalate_to_customer: "Escalate to customer",
  provide_test_results: "Attach test results",
  other: "Other",
};

// Ordered for dropdown presentation in AddRecoveryActionModal.
// Most-likely-used first; "other" last as fallback.
export const ACTION_TYPE_ORDERED: RecoveryActionType[] = [
  "recapture_proof",
  "documentation_fix",
  "provide_test_results",
  "clarify_with_customer",
  "internal_qc_check",
  "re_submit_to_customer",
  "field_revisit",
  "escalate_internal",
  "escalate_to_customer",
  "other",
];

export const ACTION_STATUS_DISPLAY: Record<RecoveryActionStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  skipped: "Skipped",
};

export const ACTION_STATUS_PILL_CLASS: Record<RecoveryActionStatus, string> = {
  open: "bg-gray-500/15 text-gray-200 border-gray-400/30",
  in_progress: "bg-blue-500/15 text-blue-200 border-blue-400/30",
  blocked: "bg-rose-500/15 text-rose-200 border-rose-400/30",
  done: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  skipped: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

// ── Cause display ──────────────────────────────────────────────────

export const CAUSE_DISPLAY: Record<RecoveryCausePrimary, string> = {
  missing_required_proof: "Missing required proof",
  proof_quality_insufficient: "Photo unclear",
  wrong_proof_uploaded: "Wrong file attached",
  documentation_error: "Doc had errors",
  customer_changed_requirements: "Customer changed scope",
  scope_dispute: "Scope dispute",
  compliance_failure: "Compliance gap",
  unclear_customer_feedback: "Customer feedback unclear",
  internal_qc_caught: "Caught in QC",
  missing_test_result: "Missing test result",
  other: "Other",
};

export const CAUSE_ORDERED: RecoveryCausePrimary[] = [
  "missing_required_proof",
  "proof_quality_insufficient",
  "wrong_proof_uploaded",
  "documentation_error",
  "missing_test_result",
  "customer_changed_requirements",
  "scope_dispute",
  "compliance_failure",
  "unclear_customer_feedback",
  "internal_qc_caught",
  "other",
];

// ── Source display ────────────────────────────────────────────────

export const SOURCE_DISPLAY: Record<RecoverySource, string> = {
  customer_rejected: "Customer rejected",
  internal_qc: "Internal QC catch",
};

// ── Revenue type display ──────────────────────────────────────────

export const REVENUE_TYPE_DISPLAY: Record<RevenueType, string> = {
  actual: "actual",
  estimated: "estimated",
  unknown: "unknown",
};

export const REVENUE_TYPE_SHORT: Record<RevenueType, string> = {
  actual: "✓ act",
  estimated: "~ est",
  unknown: "? unk",
};

// ── Owner role display ────────────────────────────────────────────

export const OWNER_ROLE_DISPLAY: Record<OwnerRole, string> = {
  coordinator: "Coordinator",
  supervisor: "Supervisor",
  field_lead: "Field lead",
  manager: "Manager",
};

// ── Revenue formatter ─────────────────────────────────────────────

export function formatRevenue(amount: number, currency = "USD"): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `$${Math.round(amount).toLocaleString()}`;
  }
}
