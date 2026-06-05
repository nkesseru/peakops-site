// PEAKOPS_RECOVERY_AUTO_FLIP_V1 (PR 130a)
//
// Shared helper extracted from PR 129a's updateRecoveryActionV1 auto-
// transition gate. Called by both:
//   - updateRecoveryActionV1 (admin/coordinator path)
//   - completeRecoveryFieldWorkV1 (foreman wrapper, PR 130a)
//
// Behavior:
//   If the just-completed action moved to a terminal action-status
//   (done|skipped) AND zero actions on the case remain open/in_progress/
//   blocked, flip the case to ready_to_resubmit + emit
//   case_ready_for_resubmission + case_status_changed audit rows.
//
// Idempotent: if the case is already past ready_to_resubmit (e.g.
// already awaiting_customer or terminal), skip silently.
//
// Best-effort: never throws. Callers should never fail the parent
// action update because of an auto-flip error.

const { FieldValue } = require("firebase-admin/firestore");
const {
  RECOVERY_STATUS,
  canTransitionRecovery,
} = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");

// PR 129a — action statuses that count as "open work" for the
// ready-to-resubmit gate.
const OPEN_ACTION_STATUSES = new Set(["open", "in_progress", "blocked"]);

/**
 * Try to flip the case to ready_to_resubmit if conditions are met.
 *
 * @param {object} args
 * @param {FirebaseFirestore.DocumentReference} args.caseRef
 * @param {string} args.orgId
 * @param {string} args.caseId
 * @param {string} args.incidentId
 * @param {string} args.actionId         the action that just moved
 * @param {string} args.newActionStatus  the status the action moved to
 * @returns {Promise<boolean>} true when a flip happened
 */
async function tryAutoFlipToReadyToResubmit({
  caseRef, orgId, caseId, incidentId, actionId, newActionStatus,
}) {
  try {
    const movedToTerminal = newActionStatus === "done" || newActionStatus === "skipped";
    if (!movedToTerminal) return false;

    const freshCaseSnap = await caseRef.get();
    const freshStatus = String((freshCaseSnap.data() || {}).status || "");
    const eligibleFrom =
      freshStatus === RECOVERY_STATUS.OPEN ||
      freshStatus === RECOVERY_STATUS.IN_PROGRESS;
    if (!eligibleFrom) return false;
    if (!canTransitionRecovery(freshStatus, RECOVERY_STATUS.READY_TO_RESUBMIT)) return false;

    const actionsSnap = await caseRef.collection("actions").get();
    let totalActions = 0;
    let doneCount = 0;
    let skippedCount = 0;
    let openCount = 0;
    for (const d of actionsSnap.docs) {
      totalActions += 1;
      const s = String((d.data() || {}).status || "");
      if (s === "done") doneCount += 1;
      else if (s === "skipped") skippedCount += 1;
      else if (OPEN_ACTION_STATUSES.has(s)) openCount += 1;
    }
    if (totalActions === 0 || openCount > 0) return false;

    await caseRef.update({
      status: RECOVERY_STATUS.READY_TO_RESUBMIT,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "system",
    });
    await writeRecoveryAudit({
      type: "case_ready_for_resubmission",
      orgId, caseId, incidentId,
      actorUid: "system",
      meta: {
        totalActions, doneCount, skippedCount,
        triggeredByActionId: actionId,
        fromStatus: freshStatus,
      },
    });
    await writeRecoveryAudit({
      type: "case_status_changed",
      orgId, caseId, incidentId,
      actorUid: "system",
      before: { status: freshStatus },
      after: { status: RECOVERY_STATUS.READY_TO_RESUBMIT },
      meta: { reason: "all_actions_complete" },
    });
    console.log("[_recoveryAutoFlip] flipped", {
      orgId, caseId, totalActions, doneCount, skippedCount,
    });
    return true;
  } catch (e) {
    console.error("[_recoveryAutoFlip] failed", e && e.message);
    return false;
  }
}

module.exports = {
  tryAutoFlipToReadyToResubmit,
  OPEN_ACTION_STATUSES,
};
