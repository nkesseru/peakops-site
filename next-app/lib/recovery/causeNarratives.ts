// PEAKOPS_RECOVERY_UI_V1 (PR 127d)
//
// Cause → mission-briefing narratives. Each cause primary maps to a
// fallback Problem title (used when no customer comment exists) and a
// Reason paragraph explaining why this matters in plain language.
//
// Approved 2026-06-04 mission-briefing redesign. Strings are
// code-review gated; new cause entries land here in the same PR
// that extends the backend RECOVERY_CAUSE_PRIMARY enum.

import type { RecoveryCausePrimary } from "./types";

type Narrative = {
  titleFallback: string;
  why: string;
};

export const CAUSE_NARRATIVES: Record<RecoveryCausePrimary, Narrative> = {
  missing_required_proof: {
    titleFallback: "Required proof is missing",
    why: "Customer needs this proof to verify the work was done. Without it, the packet won't be accepted.",
  },
  proof_quality_insufficient: {
    titleFallback: "Proof quality not good enough",
    why: "Customer can't verify the work — proof is too blurry, dim, or low-resolution to read.",
  },
  wrong_proof_uploaded: {
    titleFallback: "Wrong proof in this slot",
    why: "The attached proof doesn't match what's required here. Customer can't accept the substitution.",
  },
  documentation_error: {
    titleFallback: "Documentation doesn't match the work",
    why: "Notes or narrative contradict the work performed. Customer reads it as inconsistent.",
  },
  customer_changed_requirements: {
    titleFallback: "Customer requirements changed",
    why: "Requirements moved after the work started. The current packet no longer meets them.",
  },
  scope_dispute: {
    titleFallback: "Scope dispute",
    why: "Customer disputes what was contracted. They won't accept the packet until scope is resolved.",
  },
  compliance_failure: {
    titleFallback: "Compliance failure",
    why: "A regulatory, safety, or contractual gate isn't satisfied. Resolve before resubmitting.",
  },
  unclear_customer_feedback: {
    titleFallback: "Customer feedback unclear",
    why: "Customer rejected without saying what to fix. Reach out for clarification before working.",
  },
  internal_qc_caught: {
    titleFallback: "Internal QC catch",
    why: "Caught before the customer saw it. Fix internally; no customer involvement yet.",
  },
  other: {
    titleFallback: "See operator notes",
    why: "Custom situation. Operator should add notes explaining what needs to change.",
  },
};

export function getCauseNarrative(primary?: string): Narrative {
  const key = (primary || "").toLowerCase() as RecoveryCausePrimary;
  return CAUSE_NARRATIVES[key] || {
    titleFallback: "Needs triage",
    why: "Cause hasn't been categorized yet. Open the case to triage and define the next action.",
  };
}
