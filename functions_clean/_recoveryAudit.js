// PEAKOPS_RECOVERY_AUDIT_V1 (PR 127a)
//
// Shared writer for the cross-incident recovery audit collection.
// Mirrors the writeAuditEntry pattern in saveOrgTemplateV1 / the
// customer_review_audit writes (PR 126a) — best-effort, never fails
// the parent operation.
//
// All recovery state changes route through here so reporting,
// analytics, and dispute resolution have one canonical event stream.

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

/**
 * Append an audit row to orgs/{orgId}/recovery_audit/{auto-id}.
 *
 * Event types:
 *   PR 127a:
 *     case_opened, case_auto_opened_from_rejection, case_assigned,
 *     case_status_changed, case_priority_changed, case_revenue_updated,
 *     case_resolved, revenue_recovered, action_created, action_assigned,
 *     action_status_changed, action_completed, packet_version_appended
 *   PR 129a:
 *     case_ready_for_resubmission (auto, when all actions complete)
 *     case_resubmitted (operator-driven, via mintResubmissionLinkV1)
 *     case_re_rejected (customer re-rejects an awaiting_customer packet)
 *     packet_version_outcome (every outcome write on a PacketVersionRef)
 *   PR 132a — Recovery Intelligence event enrichments + new event:
 *     cause_overridden (operator manually changes cause.primary)
 *     case_resolved meta:        + timeToResolutionSec,
 *                                  totalResubmissions,
 *                                  totalActionsCompleted, totalActions
 *     revenue_recovered meta:    + timeToResolutionSec,
 *                                  totalResubmissions
 *     action_completed meta:     + timeToCompleteSec,
 *                                  evidenceAttachedCount,
 *                                  actionType
 *     packet_version_outcome meta: + timeToOutcomeSec,
 *                                    templateVersionAtMint
 *   PR 127a1 / 128a (deprecated, no longer emitted):
 *     case_triaged — state collapsed into `open`; the
 *     cause.inferredFromComment + cause.categorizedBy fields carry
 *     the same signal.
 *
 * @param {object} entry
 * @param {string} entry.type
 * @param {string} entry.orgId
 * @param {string} entry.caseId
 * @param {string} [entry.incidentId]
 * @param {string} [entry.actionId]      // for action-* events
 * @param {string} [entry.actorUid]
 * @param {string} [entry.actorRole]
 * @param {object} [entry.before]        // delta capture
 * @param {object} [entry.after]
 * @param {object} [entry.meta]          // extra fields (e.g., tokenHashPrefix)
 * @returns {Promise<void>}
 */
async function writeRecoveryAudit(entry) {
  try {
    const db = getFirestore();
    const orgId = String((entry && entry.orgId) || "").trim();
    if (!orgId) return;
    await db
      .collection("orgs").doc(orgId)
      .collection("recovery_audit")
      .add({
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error("[_recoveryAudit] write failed", e && e.message);
  }
}

module.exports = { writeRecoveryAudit };
