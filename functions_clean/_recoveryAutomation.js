// PEAKOPS_RECOVERY_AUTOMATION_V1 (PR 128a)
//
// Two explicit maps that drive recovery automation. Both are
// code-review gated; no rules engine, no runtime config.
//
// 1. CUSTOMER_COMMENT_CAUSE_KEYWORDS — substring map used by
//    _recoveryAutoCreate to derive cause.primary from the rejection
//    comment at case-creation time. First-match wins. Lowercased.
//
// 2. RECOVERY_CAUSE_AUTOMATION — per cause, the canonical chain of
//    suggested Recovery Actions. Surfaced via getRecoveryCaseV1's
//    `suggestedActions` field. The UI shows them as suggestions;
//    nothing writes to the case until the operator clicks Add.
//
// Wedge guard: this is the WHOLE automation surface. No triggers,
// no schedules, no chains beyond this static map, no per-org tunable
// configuration.

const RECOVERY_CAUSE_PRIMARY_SET = new Set([
  "missing_required_proof",
  "proof_quality_insufficient",
  "wrong_proof_uploaded",
  "documentation_error",
  "customer_changed_requirements",
  "scope_dispute",
  "compliance_failure",
  "unclear_customer_feedback",
  "internal_qc_caught",
  "missing_test_result",
  "other",
]);

// ── Comment → cause keyword map ───────────────────────────────────
// Order matters: more-specific phrases first. First substring
// match wins. All matching is lowercased. No regex, no fuzzy.
const CUSTOMER_COMMENT_CAUSE_KEYWORDS = Object.freeze([
  // Telecom-specific (PR 128a, telecom blind spot)
  ["otdr",                "missing_test_result"],
  ["test result",         "missing_test_result"],
  ["loss measurement",    "missing_test_result"],
  ["splice report",       "missing_test_result"],

  // Specific proof issues (must come before generic "missing")
  ["wrong photo",         "wrong_proof_uploaded"],
  ["wrong slot",          "wrong_proof_uploaded"],
  ["wrong proof",         "wrong_proof_uploaded"],

  ["blurry",              "proof_quality_insufficient"],
  ["unreadable",          "proof_quality_insufficient"],
  ["low resolution",      "proof_quality_insufficient"],
  ["can't read",          "proof_quality_insufficient"],
  ["cannot read",         "proof_quality_insufficient"],

  // Generic missing
  ["missing",             "missing_required_proof"],
  ["not provided",        "missing_required_proof"],

  ["doesn't match",       "documentation_error"],
  ["contradicts",         "documentation_error"],

  ["not what we agreed",  "scope_dispute"],
  ["wasn't agreed",       "scope_dispute"],
  ["wasn't in scope",     "scope_dispute"],

  ["doesn't comply",      "compliance_failure"],
  ["regulation",          "compliance_failure"],
  ["safety code",         "compliance_failure"],

  ["unclear",             "unclear_customer_feedback"],
  ["please clarify",      "unclear_customer_feedback"],
]);

/**
 * Derive cause.primary from a customer rejection comment. First-match
 * (substring, lowercased) wins. Returns null if no match.
 *
 * @param {string} comment
 * @returns {string | null}
 */
function deriveCauseFromComment(comment) {
  const lower = String(comment || "").trim().toLowerCase();
  if (!lower) return null;
  for (const [needle, cause] of CUSTOMER_COMMENT_CAUSE_KEYWORDS) {
    if (lower.includes(needle)) return cause;
  }
  return null;
}

// ── Cause → suggested actions map ─────────────────────────────────
// Each entry is the canonical recovery chain for that cause.
// Operator confirms via [Add] per action or [Add all] in the UI.
// Default descriptions are pre-populated so a click is enough.
const RECOVERY_CAUSE_AUTOMATION = Object.freeze({
  missing_required_proof: [
    {
      type: "recapture_proof",
      title: "Capture missing required proof",
      description: "Return to site and capture the proof item the customer requires for acceptance.",
      assigneeRole: "field_lead",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Once proof is captured and approved, mint a new customer review link from the incident summary.",
      assigneeRole: "coordinator",
    },
  ],
  proof_quality_insufficient: [
    {
      type: "recapture_proof",
      title: "Re-shoot the rejected proof",
      description: "Match the customer's quality requirement: clear focus, slate label visible, full resolution.",
      assigneeRole: "field_lead",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "After re-shoot is uploaded and approved, mint a new customer review link.",
      assigneeRole: "coordinator",
    },
  ],
  wrong_proof_uploaded: [
    {
      type: "documentation_fix",
      title: "Re-attach correct proof to the right slot",
      description: "Move the correctly-matching proof into the expected slot in the evidence locker.",
      assigneeRole: "supervisor",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Confirm slot mapping is correct, then mint a new customer review link.",
      assigneeRole: "coordinator",
    },
  ],
  documentation_error: [
    {
      type: "documentation_fix",
      title: "Correct the documentation",
      description: "Update narrative or notes to reflect the work actually performed. Remove contradictions.",
      assigneeRole: "supervisor",
    },
    {
      type: "internal_qc_check",
      title: "Supervisor re-review",
      description: "Verify the corrected documentation before exposure to the customer.",
      assigneeRole: "supervisor",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Mint a new customer review link after QC passes.",
      assigneeRole: "coordinator",
    },
  ],
  customer_changed_requirements: [
    {
      type: "clarify_with_customer",
      title: "Confirm what changed",
      description: "Reach out to the customer to capture exactly what new requirements apply and to what records.",
      assigneeRole: "coordinator",
    },
    {
      type: "recapture_proof",
      title: "Capture any newly-required proof",
      description: "Return to site if the changed requirements introduce new proof items.",
      assigneeRole: "field_lead",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Once the packet meets the new requirements, mint a new customer review link.",
      assigneeRole: "coordinator",
    },
  ],
  scope_dispute: [
    {
      type: "escalate_internal",
      title: "Escalate internally",
      description: "Loop in management — scope disputes are above the coordinator level.",
      assigneeRole: "manager",
    },
    {
      type: "escalate_to_customer",
      title: "Escalate to customer",
      description: "Coordinator-level conversation with the customer's project owner.",
      assigneeRole: "manager",
    },
  ],
  compliance_failure: [
    {
      type: "provide_test_results",
      title: "Provide compliance test results",
      description: "Submit the documentation that proves the failed gate is now satisfied (test reports, code references, certifications).",
      assigneeRole: "field_lead",
    },
    {
      type: "internal_qc_check",
      title: "Supervisor compliance re-review",
      description: "Confirm the compliance gate is met before re-exposing to the customer.",
      assigneeRole: "supervisor",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Mint a new customer review link after compliance is verified.",
      assigneeRole: "coordinator",
    },
  ],
  unclear_customer_feedback: [
    {
      type: "clarify_with_customer",
      title: "Reach out for specifics",
      description: "The customer's rejection comment didn't say what to fix. Get clarification before working.",
      assigneeRole: "coordinator",
    },
  ],
  internal_qc_caught: [
    {
      type: "internal_qc_check",
      title: "Supervisor review",
      description: "QC caught the issue before the customer. Review and decide the corrective action.",
      assigneeRole: "supervisor",
    },
  ],
  missing_test_result: [
    {
      type: "provide_test_results",
      title: "Provide test results",
      description: "Submit the test data the customer needs (OTDR trace, loss measurement, splice report).",
      assigneeRole: "field_lead",
    },
    {
      type: "re_submit_to_customer",
      title: "Resubmit packet",
      description: "Mint a new customer review link once test results are attached.",
      assigneeRole: "coordinator",
    },
  ],
  other: [],
});

/**
 * Return the list of suggested action chains for a given cause primary,
 * filtered against actions already present on the case (by type — we
 * don't suggest something the operator has already added).
 *
 * @param {string} causePrimary
 * @param {Array<{type?: string}>} existingActions
 * @returns {Array<{type: string, title: string, description: string, assigneeRole: string}>}
 */
function getSuggestedActions(causePrimary, existingActions) {
  const cause = String(causePrimary || "").toLowerCase();
  if (!RECOVERY_CAUSE_PRIMARY_SET.has(cause)) return [];
  const chain = RECOVERY_CAUSE_AUTOMATION[cause] || [];
  const existingTypes = new Set(
    (Array.isArray(existingActions) ? existingActions : [])
      .map((a) => String((a && a.type) || "").toLowerCase())
      .filter(Boolean)
  );
  return chain.filter((s) => !existingTypes.has(s.type));
}

module.exports = {
  CUSTOMER_COMMENT_CAUSE_KEYWORDS,
  RECOVERY_CAUSE_AUTOMATION,
  deriveCauseFromComment,
  getSuggestedActions,
};
