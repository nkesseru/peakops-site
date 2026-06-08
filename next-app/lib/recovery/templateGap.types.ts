// PEAKOPS_RECOVERY_TEMPLATE_GAP_TYPES_V1 (PR 132c-b)
//
// Types + per-cause recommendation copy for the "Revenue Protection
// Opportunity" strip rendered in the Template Editor.
//
// Architecture lock (PR 132c planning, locked 2026-06-08):
//   - Title is "Revenue Protection Opportunity" (decision lock #6)
//   - Window is locked to 30 days; no selector
//   - Threshold: render only when rejections >= 3 in window
//   - All tied top causes are shown (no arbitrary pick)
//   - Recommendation copy is action-oriented per the mapping below
//   - Some causes intentionally produce no recommendation (the gap
//     isn't typically a template-editable thing)
//
// Source of truth — UI imports this file; any future copy edits land
// here, code-review gated like PR 128a's RECOVERY_CAUSE_AUTOMATION map.

// Response shape returned by getRecoveryAggregatesV1 when
// type=template_gap&templateKey=X. Mirrors the backend doc but
// surfaces only what the strip uses.
export type TemplateGapSummary = {
  ok: boolean;
  orgId?: string;
  type?: "template_gap";
  windowDays?: number;
  templateKey?: string;
  summary?: {
    windowStart?: string;
    windowEnd?: string;
    windowDays?: number;
    metrics?: TemplateGapMetrics;
    samplesInWindow?: number;
  };
  lifetime?: TemplateGapMetrics;
  error?: string;
};

export type TemplateGapMetrics = {
  rejections?: number;
  causeMix?: { [cause: string]: number };
  versionMix?: { [versionKey: string]: number };
  recoveredCount?: number;
  abandonedCount?: number;
  partialRecoveryCount?: number;
  caseResolutions?: number;
  totalRecoveryDurationSec?: number;
  recoveryDurationSamples?: number;
  totalRevenueRecovered?: number;
};

// PR 132c-b — Per-cause recommendation copy. Approved at PR 132c
// planning, refined for clarity here. Keep action-oriented.
//
// Causes NOT in this map intentionally produce no recommendation
// block — the strip still shows counts + version mix, but no
// "Recommended action" text. This is the wedge guard against
// telling admins to edit templates for issues that aren't template
// gaps (scope_dispute, customer_changed_requirements, etc.).
type RecommendationEntry = {
  headline: string;
  recommendation: string;
};

export const TEMPLATE_GAP_RECOMMENDATIONS: Record<string, RecommendationEntry> = {
  missing_required_proof: {
    headline: "Customers asked for proof items not in this template's required list.",
    recommendation: "Add the missing proof items to required so they're captured on the first submission.",
  },
  missing_test_result: {
    headline: "Customers asked for test data (OTDR trace, loss measurement, splice report) this template didn't require.",
    recommendation: "Add the requested test result type to required proof.",
  },
  proof_quality_insufficient: {
    headline: "Proofs from this template didn't meet customer quality standards.",
    recommendation: "Add a quality gate to required — resolution, focus, slate label visibility — so weak proofs flag at capture time.",
  },
  wrong_proof_uploaded: {
    headline: "Operators uploaded the wrong proof to the wrong slot on this template.",
    recommendation: "Clarify slot labels and add slot-specific examples so the right proof lands in the right place.",
  },
  documentation_error: {
    headline: "Documentation from this template contradicted itself across submissions.",
    recommendation: "Tighten the narrative guidance with required elements and required language for the field/coordinator.",
  },
  compliance_failure: {
    headline: "Compliance gates failed for cases on this template.",
    recommendation: "Add the missing regulatory or safety checks to the acceptance criteria.",
  },
};

// Causes the strip will COUNT but not recommend a template edit for.
// These are operator/customer-relationship issues, not template gaps.
export const NON_TEMPLATE_FIXABLE_CAUSES = new Set<string>([
  "scope_dispute",
  "customer_changed_requirements",
  "unclear_customer_feedback",
  "internal_qc_caught",
  "other",
]);

// "unknown" appears in aggregate causeMix when the auto-create
// inferrer couldn't categorize the customer comment. Exclude from
// top-cause derivation — it tells the admin nothing actionable, and
// is usually the largest bucket for low-keyword orgs.
export const TOP_CAUSE_EXCLUSIONS = new Set<string>(["unknown"]);

// Display labels for cause primaries in the cause-mix list. Mirrors
// lib/recovery/displayConstants.ts CAUSE_DISPLAY but kept local so
// the template-gap strip can render unknown labels gracefully (the
// strip can encounter causes not in the canonical enum if backend
// adds new ones, including "unknown").
export const CAUSE_DISPLAY_LOCAL: Record<string, string> = {
  missing_required_proof: "Missing required proof",
  proof_quality_insufficient: "Proof quality insufficient",
  wrong_proof_uploaded: "Wrong proof uploaded",
  documentation_error: "Documentation error",
  customer_changed_requirements: "Customer changed requirements",
  scope_dispute: "Scope dispute",
  compliance_failure: "Compliance failure",
  unclear_customer_feedback: "Unclear customer feedback",
  internal_qc_caught: "Internal QC catch",
  missing_test_result: "Missing test result",
  other: "Other",
  unknown: "Not categorized",
};

/**
 * From a causeMix, return all causes tied at the highest count,
 * excluding "unknown" and any other excluded keys.
 *
 * Examples:
 *   { missing_required_proof: 3, scope_dispute: 3, unknown: 8 }
 *     → ["missing_required_proof", "scope_dispute"]  (tied at 3)
 *   { missing_test_result: 5, unknown: 27 }
 *     → ["missing_test_result"]                       (only one after exclusion)
 *   { unknown: 27 }
 *     → []                                            (nothing actionable)
 */
export function deriveTopCauses(causeMix: { [k: string]: number } | undefined): string[] {
  if (!causeMix || typeof causeMix !== "object") return [];
  const entries = Object.entries(causeMix)
    .filter(([k, v]) => !TOP_CAUSE_EXCLUSIONS.has(k) && typeof v === "number" && v > 0)
    .map(([k, v]) => [k, Number(v)] as [string, number]);
  if (entries.length === 0) return [];
  const maxCount = entries.reduce((m, [, v]) => Math.max(m, v), 0);
  return entries
    .filter(([, v]) => v === maxCount)
    .map(([k]) => k)
    .sort();
}

/**
 * Filter top causes to only those with recommendation copy. When no
 * top cause has a recommendation, the UI hides the "Recommended
 * action" block entirely (counts still render).
 */
export function fixableTopCauses(topCauses: string[]): string[] {
  return topCauses.filter((c) => Boolean(TEMPLATE_GAP_RECOMMENDATIONS[c]));
}
