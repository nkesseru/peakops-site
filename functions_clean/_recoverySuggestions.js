// PEAKOPS_RECOVERY_SUGGESTIONS_V1 (PR 131a)
//
// Read-time helpers that compute "PeakOps suggests; humans approve"
// values surfaced via getRecoveryCaseV1's `case.suggestions` block.
//
// Architecture lock for Phase 2 automation (PR 131 planning):
//   1. Every suggestion is computed when an operator opens a case.
//      No background jobs, no triggers, no fan-out.
//   2. Suggestions are pre-fills + signals. The UI surfaces them
//      visibly distinct from saved values; the operator must take
//      a deliberate action to commit.
//   3. No automation that runs without a click. No bulk operations.
//   4. Architecture stays revenue-recovery, not workflow software.
//
// Three suggestions live here:
//
//   1. changeSummary — bullet list of actions completed since the
//      previous packet version. Pre-fills the ResubmissionBanner's
//      "What changed?" textarea.
//
//   2. revenueAtRiskSuggestion — priority chain for guessing the $
//      amount when the case's revenueAtRisk is empty / unknown.
//      Priority (per PR 131 decision lock):
//        actual on prior data → estimated on prior data →
//        sum of incident jobs → unknown (null)
//
//   3. resubmissionReadiness — green/red/neutral state, always
//      present. Drives the inline readiness strip the coordinator
//      sees above the mint CTA.

const RECOVERY_STATUS = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  READY_TO_RESUBMIT: "ready_to_resubmit",
  AWAITING_CUSTOMER: "awaiting_customer",
  ESCALATED: "escalated",
  RECOVERED: "recovered",
  PARTIAL_RECOVERY: "partial_recovery",
  ABANDONED: "abandoned",
  EXPIRED: "expired",
};

// Action statuses we consider "open work" for readiness purposes.
const OPEN_ACTION_STATUSES = new Set(["open", "in_progress", "blocked"]);

// Common revenue field names we'll look for on incident + job docs.
// Forward-compatible: if a future schema adds estimatedRevenue or
// billableAmount to jobs, this helper picks it up without further code
// changes. None of these fields exist in the current schema; the
// helper returns null suggestions today and lights up automatically
// when the data appears.
const REVENUE_FIELD_NAMES = ["estimatedRevenue", "revenue", "billableAmount", "amount"];

function trim(v) { return String(v == null ? "" : v).trim(); }

function tsMs(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v?.toDate) {
    try { return v.toDate().getTime(); } catch { return null; }
  }
  if (v?._seconds) {
    return (Number(v._seconds) || 0) * 1000;
  }
  return null;
}

// ── 1. changeSummary ──────────────────────────────────────────────
/**
 * Build a "Changes made:" bullet list from actions completed since
 * the previous packet was sent. Returns null when there's nothing to
 * say (e.g., first time minting v1, or no completed actions between
 * packets).
 *
 * @param {Array<{ ordinal?: number, outcomeAt?: any, outcome?: string }>} packetVersions
 * @param {Array<{ status?: string, title?: string, completedAt?: any }>} actions
 * @returns {string | null}
 */
function deriveChangeSummary(packetVersions, actions) {
  const sortedPkts = (Array.isArray(packetVersions) ? packetVersions.slice() : [])
    .sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0));
  if (sortedPkts.length === 0) return null;

  // Most recent FULLY-CLOSED packet (i.e., outcome != pending). Open
  // operator is preparing the NEXT mint, so we compare against the
  // last packet the customer actually saw.
  let lastClosed = null;
  for (let i = sortedPkts.length - 1; i >= 0; i--) {
    const p = sortedPkts[i];
    if (trim(p.outcome) && trim(p.outcome) !== "pending") {
      lastClosed = p;
      break;
    }
  }
  if (!lastClosed) return null;
  const cutoffMs = tsMs(lastClosed.outcomeAt);
  if (!cutoffMs) return null;

  const completedSince = (Array.isArray(actions) ? actions : [])
    .filter((a) => trim(a.status) === "done" || trim(a.status) === "skipped")
    .map((a) => ({ title: trim(a.title) || trim(a.type), completedMs: tsMs(a.completedAt) }))
    .filter((a) => a.title && a.completedMs && a.completedMs > cutoffMs)
    .sort((a, b) => a.completedMs - b.completedMs);

  if (completedSince.length === 0) return null;

  const bullets = completedSince.map((a) => `• ${a.title}`).join("\n");
  return `Changes made:\n${bullets}`;
}

// ── 2. revenueAtRisk suggestion ───────────────────────────────────

function readRevenueFromDoc(doc) {
  if (!doc || typeof doc !== "object") return null;
  for (const k of REVENUE_FIELD_NAMES) {
    const v = Number(doc[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * Suggest a revenueAtRisk amount + type when the case's value is
 * empty or unknown. Priority chain (PR 131a decision lock):
 *   1. case has actual revenue already → no suggestion (use stored)
 *   2. case has estimated revenue already → no suggestion (use stored)
 *   3. Look on incident doc for a revenue field marked actual-ish
 *      → suggestion type=actual
 *   4. Look on incident doc for a revenue field (any) → estimated
 *   5. Sum jobs[]'s revenue fields → estimated, source=sum_of_jobs
 *   6. None of the above → null (no suggestion)
 *
 * Today's schema has none of the source fields populated, so this
 * usually returns null. The chain is forward-compatible: if a future
 * field lights up, suggestions appear automatically.
 *
 * @param {object} args
 * @param {object} [args.caseData]
 * @param {object} [args.incidentData]
 * @param {Array<object>} [args.jobsData]
 * @returns {{ amount: number, type: "actual"|"estimated", source: string } | null}
 */
function deriveRevenueAtRiskSuggestion({ caseData, incidentData, jobsData }) {
  const persistedAmount = Number(caseData?.revenueAtRisk?.amount);
  const persistedType = trim(caseData?.revenueAtRisk?.type).toLowerCase();
  // 1+2: already known on the case → no suggestion needed.
  if (Number.isFinite(persistedAmount) && persistedAmount > 0
      && (persistedType === "actual" || persistedType === "estimated")) {
    return null;
  }

  // 3+4: incident-level revenue field.
  if (incidentData && typeof incidentData === "object") {
    const incAmt = readRevenueFromDoc(incidentData);
    if (incAmt) {
      // If the incident explicitly tags this as actual (e.g.
      // revenueType: "actual"), promote; default to estimated.
      const incType = trim(incidentData.revenueType).toLowerCase();
      const type = incType === "actual" ? "actual" : "estimated";
      return { amount: incAmt, type, source: "incident" };
    }
  }

  // 5: sum the jobs.
  if (Array.isArray(jobsData) && jobsData.length > 0) {
    let sum = 0;
    let foundAny = false;
    for (const j of jobsData) {
      const v = readRevenueFromDoc(j);
      if (v) { sum += v; foundAny = true; }
    }
    if (foundAny && sum > 0) {
      return { amount: sum, type: "estimated", source: "sum_of_jobs" };
    }
  }

  // 6: nothing.
  return null;
}

// ── 3. resubmissionReadiness ──────────────────────────────────────
/**
 * Build the readiness signal that always renders on the case detail.
 * Three visual states: green (ready), red (blocked), neutral
 * (terminal / not applicable).
 *
 * @param {object} args
 * @param {object} args.caseData
 * @param {Array<{ status?: string }>} args.actions
 * @returns {{
 *   state: "green" | "red" | "neutral",
 *   ready: boolean,
 *   headline: string,
 *   reasons: string[],
 *   warnings: string[],
 * }}
 */
function deriveResubmissionReadiness({ caseData, actions }) {
  const status = trim(caseData?.status).toLowerCase();
  const acts = Array.isArray(actions) ? actions : [];
  const openCount = acts.filter((a) => OPEN_ACTION_STATUSES.has(trim(a.status))).length;
  const doneCount = acts.filter((a) => trim(a.status) === "done").length;
  const skippedCount = acts.filter((a) => trim(a.status) === "skipped").length;
  const totalActions = acts.length;

  // Terminal cases: neutral. The UI shows the resolution, not a
  // readiness banner.
  if (
    status === RECOVERY_STATUS.RECOVERED ||
    status === RECOVERY_STATUS.PARTIAL_RECOVERY ||
    status === RECOVERY_STATUS.ABANDONED ||
    status === RECOVERY_STATUS.EXPIRED
  ) {
    return {
      state: "neutral",
      ready: false,
      headline: "Case closed",
      reasons: [],
      warnings: [],
    };
  }

  // awaiting_customer: neutral — already minted; nothing to mint.
  if (status === RECOVERY_STATUS.AWAITING_CUSTOMER) {
    return {
      state: "neutral",
      ready: false,
      headline: "Waiting on customer review",
      reasons: [],
      warnings: [],
    };
  }

  // ready_to_resubmit: green.
  if (status === RECOVERY_STATUS.READY_TO_RESUBMIT) {
    const reasons = [];
    if (totalActions > 0) {
      reasons.push(
        `All ${totalActions} recovery action${totalActions === 1 ? "" : "s"} complete (${doneCount} done${skippedCount > 0 ? `, ${skippedCount} skipped` : ""})`
      );
    }
    // Soft warning: did the customer ask for proof and is the
    // evidence list empty? Cheap heuristic — count attached evidence
    // across all done actions.
    const totalEvidence = acts
      .filter((a) => trim(a.status) === "done")
      .reduce((sum, a) => sum + (Array.isArray(a.evidence) ? a.evidence.length : 0), 0);
    const causeImpliesProof = ["missing_required_proof", "proof_quality_insufficient", "wrong_proof_uploaded", "missing_test_result"]
      .includes(trim(caseData?.cause?.primary).toLowerCase());
    const warnings = [];
    if (causeImpliesProof && totalEvidence === 0) {
      warnings.push("Customer asked for proof, but no evidence is attached to any completed action yet.");
    }
    return {
      state: "green",
      ready: true,
      headline: "Ready to resubmit",
      reasons,
      warnings,
    };
  }

  // open / in_progress / escalated: red — open work remains OR the
  // case is escalated (escalated isn't "ready" in the resubmit sense
  // either; coordinator must resolve the escalation path first).
  const reasons = [];
  if (totalActions === 0) {
    reasons.push("No recovery actions added yet. Add at least one and complete it before resubmitting.");
  } else if (openCount > 0) {
    reasons.push(
      `${openCount} action${openCount === 1 ? " is" : "s are"} still open. Complete or skip them before resubmitting.`
    );
  }
  if (status === RECOVERY_STATUS.ESCALATED) {
    reasons.push("Case is escalated. Resolve the escalation before minting a new customer link.");
  }
  return {
    state: "red",
    ready: false,
    headline: "Not ready yet",
    reasons,
    warnings: [],
  };
}

module.exports = {
  deriveChangeSummary,
  deriveRevenueAtRiskSuggestion,
  deriveResubmissionReadiness,
  // Exported for the smoke harness to assert behavior directly.
  REVENUE_FIELD_NAMES,
};
