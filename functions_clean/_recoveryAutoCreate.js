// PEAKOPS_RECOVERY_AUTO_CREATE_V1 (PR 127a)
//
// Transactional helper called inline from submitCustomerReviewV1
// (on reject) and from internal-QC flows (Phase 2). Two responsibilities:
//
//   1. If an open recovery case exists for the incident, EXTEND it
//      by appending a PacketVersionRef and (when applicable) reverting
//      its status from awaiting_customer → in_progress so the operator
//      knows the second rejection landed.
//
//   2. If no open case exists, CREATE a new case with a deterministic
//      id (case_${incidentId}_${tokenHashPrefix}) plus a starter
//      Recovery Action so the operator has somewhere to start.
//
// Both branches run inside a single Firestore transaction. Retries are
// idempotent because:
//   - The case id is deterministic on the auto-create path
//   - The PacketVersionRef append checks for an existing match by
//     packetVersionId before adding
//   - The starter action id is deterministic too
//
// Auto-resolution (on customer_accepted) is handled by a sibling
// helper autoResolveOnAccept() in this file.

const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  RECOVERY_STATUS,
  TERMINAL_STATUSES,
  deterministicCaseId,
} = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");
// PR 128a — derive cause.primary from the customer rejection comment
// when no cause is set. First-match substring map; null on no match.
const { deriveCauseFromComment } = require("./_recoveryAutomation");

/**
 * Auto-create or extend a recovery case for an incident that just
 * received a rejection (customer or internal QC).
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.incidentId
 * @param {string} args.source              // "customer_rejected" | "internal_qc"
 * @param {string} args.actorUid            // who triggered (link minter or QC reviewer)
 * @param {string} [args.tokenHashPrefix]   // PR 126a audit anchor
 * @param {string} [args.customerComment]   // from submitCustomerReviewV1 reject body
 * @param {object} [args.packetVersion]     // PacketVersionRef snapshot, optional
 * @returns {Promise<{ caseId, created: boolean, actionId: string | null }>}
 */
async function autoCreateOrExtendCase(args) {
  const db = getFirestore();
  const orgId = String(args.orgId || "").trim();
  const incidentId = String(args.incidentId || "").trim();
  const source = String(args.source || "customer_rejected").trim();
  const actorUid = String(args.actorUid || "").trim() || "system";
  const tokenHashPrefix = args.tokenHashPrefix ? String(args.tokenHashPrefix).trim() : "";
  const customerComment = args.customerComment ? String(args.customerComment).trim() : "";

  if (!orgId || !incidentId) {
    console.warn("[_recoveryAutoCreate] missing_ids", { orgId, incidentId });
    return { caseId: "", created: false, actionId: null };
  }

  // Default priority by source.
  const priority = source === "customer_rejected" ? "medium" : "low";

  // Default starter action type by source.
  const starterActionType = source === "customer_rejected"
    ? "clarify_with_customer"
    : "internal_qc_check";
  const starterActionTitle = source === "customer_rejected"
    ? "Review customer feedback and determine next steps"
    : "Review internal QC findings";

  // Step 1: find any open case for this incident (status not in terminal).
  // We query outside the transaction because Firestore txns can't run
  // queries — only direct doc reads. The narrow query (incidentId +
  // non-terminal) is small enough that we can race-tolerate (the txn
  // below double-checks doc state).
  const casesRef = db.collection("orgs").doc(orgId).collection("recovery_cases");
  const openSnap = await casesRef
    .where("incidentId", "==", incidentId)
    .where("status", "in", [
      RECOVERY_STATUS.OPEN,
      RECOVERY_STATUS.IN_PROGRESS,
      RECOVERY_STATUS.READY_TO_RESUBMIT,
      RECOVERY_STATUS.AWAITING_CUSTOMER,
      RECOVERY_STATUS.ESCALATED,
      // PR 129a — legacy tolerance: pre-129a cases persisted with
      // status="triaged" must still be found as the active case for
      // their incident. The state was dropped from new writes but
      // remains queryable for migration.
      "triaged",
    ])
    .limit(1)
    .get();

  const existingCaseRef = !openSnap.empty ? openSnap.docs[0].ref : null;

  if (existingCaseRef) {
    // ── EXTEND existing case ─────────────────────────────────────
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(existingCaseRef);
      if (!snap.exists) {
        // Edge case: case got deleted between query and txn. Fall
        // through by returning null so the outer code creates a new one.
        return null;
      }
      const data = snap.data() || {};
      if (TERMINAL_STATUSES.has(String(data.status || ""))) {
        // Edge case: case got resolved between query and txn. Same
        // fall-through.
        return null;
      }

      const existingPkts = Array.isArray(data.packetVersions) ? data.packetVersions.slice() : [];
      const pktId = (args.packetVersion && args.packetVersion.packetVersionId) || tokenHashPrefix || "";

      // PR 129a — if the rejected packet matches a pending entry in the
      // chain (i.e., the customer just rejected the latest mint), mark
      // it as rejected in-place rather than appending a duplicate row.
      // Otherwise append.
      const pendingIdx = pktId
        ? existingPkts.findIndex((p) => String(p && p.packetVersionId || "") === pktId)
        : -1;
      let newPkts = existingPkts;
      let isReRejection = false;
      if (pendingIdx >= 0) {
        const prev = existingPkts[pendingIdx] || {};
        newPkts = existingPkts.slice();
        newPkts[pendingIdx] = {
          ...prev,
          outcome: "rejected",
          outcomeAt: new Date().toISOString(),
          customerComment: customerComment || prev.customerComment || null,
        };
        // Treat any rejection that lands on a previously-pending packet
        // as a re-rejection event — even if the case wasn't strictly in
        // awaiting_customer (defensive against race-altered state).
        isReRejection = true;
      } else if (args.packetVersion) {
        newPkts = existingPkts.concat([args.packetVersion]);
      }

      // PR 129a — re-rejection of an awaiting-customer packet bumps us
      // back to in_progress so the operator knows the loop continues.
      // Same transition rule applies to ready_to_resubmit (race: customer
      // rejects an old link after operator already marked all done).
      const wasAwaitingOrReady =
        data.status === RECOVERY_STATUS.AWAITING_CUSTOMER ||
        data.status === RECOVERY_STATUS.READY_TO_RESUBMIT;
      const newStatus = wasAwaitingOrReady
        ? RECOVERY_STATUS.IN_PROGRESS
        : data.status;

      tx.update(existingCaseRef, {
        packetVersions: newPkts,
        currentPacketVersion: pktId || data.currentPacketVersion || null,
        status: newStatus,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actorUid,
        // PR 128a — re-derive cause from the new comment (may differ
        // from the original cause). The existing operator-set cause is
        // preserved if no inference matches the new comment.
        ...(customerComment ? { "cause.customerComment": customerComment } : {}),
      });

      return {
        caseId: snap.id,
        prevStatus: data.status,
        newStatus,
        isReRejection,
        packetOrdinal: pendingIdx >= 0 ? (existingPkts[pendingIdx]?.ordinal || pendingIdx + 1) : null,
      };
    });

    if (result) {
      // PR 129a — distinguish "first-rejection packet appended" from
      // "re-rejection of an outstanding packet" in the audit stream.
      if (result.isReRejection) {
        await writeRecoveryAudit({
          type: "case_re_rejected",
          orgId, caseId: result.caseId, incidentId,
          actorUid,
          meta: {
            tokenHashPrefix,
            packetOrdinal: result.packetOrdinal,
            customerComment: customerComment || null,
            prevStatus: result.prevStatus,
          },
        });
        await writeRecoveryAudit({
          type: "packet_version_outcome",
          orgId, caseId: result.caseId, incidentId,
          actorUid,
          meta: { packetVersionId: tokenHashPrefix, outcome: "rejected" },
        });
      } else {
        await writeRecoveryAudit({
          type: "packet_version_appended",
          orgId, caseId: result.caseId, incidentId,
          actorUid,
          meta: { tokenHashPrefix, source, customerComment: customerComment || null },
        });
      }
      if (result.prevStatus !== result.newStatus) {
        await writeRecoveryAudit({
          type: "case_status_changed",
          orgId, caseId: result.caseId, incidentId,
          actorUid,
          before: { status: result.prevStatus },
          after: { status: result.newStatus },
          meta: { reason: result.isReRejection ? "customer_re_rejected" : "extended_by_new_rejection" },
        });
      }
      console.log("[_recoveryAutoCreate] extended_existing", {
        orgId, incidentId, caseId: result.caseId,
        isReRejection: result.isReRejection,
      });
      return { caseId: result.caseId, created: false, actionId: null };
    }
    // If txn returned null (case disappeared mid-flight), fall through
    // to create a new one.
  }

  // ── CREATE new case ──────────────────────────────────────────────
  // PR 129a — caseId = incidentId (sanitized). One case per incident,
  // ever. Resubmission cycles append packetVersions; new cases for the
  // same incident only happen if the prior one was already terminal.
  const caseId = deterministicCaseId(incidentId);
  const caseRef = casesRef.doc(caseId);
  const starterActionId = `action_${caseId}_starter`;
  const actionRef = caseRef.collection("actions").doc(starterActionId);

  // PR 128a — derive cause.primary from the customer comment via the
  // explicit substring keyword map. Hoisted to function scope so the
  // post-transaction audit emission block can read it.
  const inferredCause = source === "customer_rejected"
    ? deriveCauseFromComment(customerComment)
    : null;
  // PR 129a — dropped `triaged` state. Inferred cause still records
  // `cause.inferredFromComment: true` so the UI can show the marker,
  // but the case starts at `open` regardless.

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(caseRef);
    if (snap.exists) {
      // Retry-safe: case already exists with this deterministic id.
      // Treat as "extended" — append packetVersion if not present.
      const data = snap.data() || {};
      const existingPkts = Array.isArray(data.packetVersions) ? data.packetVersions.slice() : [];
      const pktId = (args.packetVersion && args.packetVersion.packetVersionId) || tokenHashPrefix || "";
      const dup = pktId && existingPkts.some((p) => String(p.packetVersionId || "") === pktId);
      if (!dup && args.packetVersion) {
        tx.update(caseRef, {
          packetVersions: existingPkts.concat([args.packetVersion]),
          currentPacketVersion: pktId || null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return { existed: true, caseId, actionId: null };
    }

    // Fresh create.
    const now = FieldValue.serverTimestamp();
    const causeDoc = {
      ...(customerComment ? { customerComment } : {}),
      ...(inferredCause ? {
        primary: inferredCause,
        inferredFromComment: true,
        categorizedBy: "system",
        categorizedAt: now,
      } : {}),
    };
    const newCase = {
      id: caseId,
      orgId,
      incidentId,
      // PR 129a — always start at open; cause.inferredFromComment is
      // the only signal that the system pre-classified.
      status: RECOVERY_STATUS.OPEN,
      priority,
      revenueAtRisk: {
        amount: 0,
        currency: "USD",
        type: "unknown",
        enteredBy: actorUid,
        enteredAt: now,
      },
      cause: causeDoc,
      rejection: {
        source,
        tokenHashPrefix: tokenHashPrefix || null,
        rejectedAt: now,
        rejectedBy: source === "customer_rejected" ? "customer" : actorUid,
      },
      ownership: {
        owner: actorUid,
        ownerRole: "coordinator",
        assignedAt: now,
        assignedBy: actorUid,
        history: [],
      },
      packetVersions: args.packetVersion ? [args.packetVersion] : [],
      currentPacketVersion: args.packetVersion ? args.packetVersion.packetVersionId : null,
      // PR 129a — cycleCount dropped; derived from packetVersions.length-1
      // in getRecoveryCaseV1 response shape (resubmissionCount).
      openedAt: now,
      slaTarget: null,
      resolvedAt: null,
      daysOpen: 0,
      resolution: null,
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
      updatedBy: actorUid,
      version: 1,
    };
    tx.set(caseRef, newCase);

    // Starter Recovery Action — deterministic id so retries don't dup.
    const starterAction = {
      id: starterActionId,
      caseId,
      orgId,
      type: starterActionType,
      title: starterActionTitle,
      status: "open",
      assignee: actorUid,
      assigneeRole: "coordinator",
      dueAt: null,
      startedAt: null,
      completedAt: null,
      evidence: [],
      outcome: null,
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
    };
    tx.set(actionRef, starterAction);

    return { existed: false, caseId, actionId: starterActionId };
  });

  if (!result.existed) {
    await writeRecoveryAudit({
      type: "case_auto_opened_from_rejection",
      orgId, caseId, incidentId,
      actorUid,
      meta: {
        source, tokenHashPrefix,
        customerComment: customerComment || null,
        priority,
        // PR 128a — record whether automation set the cause at create
        // time, so audit reporting can answer "how often does the
        // keyword map catch the right cause?"
        inferredCause: inferredCause || null,
      },
    });
    // PR 129a — dropped case_triaged emission. cause.inferredFromComment
    // is now the only signal that the system pre-classified; UI reads
    // it directly via getRecoveryCaseV1 (PR 128b).
    await writeRecoveryAudit({
      type: "action_created",
      orgId, caseId, incidentId,
      actionId: result.actionId,
      actorUid,
      meta: { type: starterActionType, starter: true },
    });
    console.log("[_recoveryAutoCreate] case_opened", {
      orgId, incidentId, caseId, source, priority,
      inferredCause: inferredCause || "(none)",
    });
  }

  return { caseId, created: !result.existed, actionId: result.actionId };
}

/**
 * Auto-resolve a recovery case when its associated packet version
 * gets accepted by the customer. Called inline from submitCustomerReviewV1
 * on action="accept" path.
 *
 * Finds an open case for this incident in awaiting_customer state,
 * transitions to recovered (terminal), captures resolution metadata.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.incidentId
 * @param {string} [args.tokenHashPrefix]
 * @param {string} [args.customerComment]
 * @returns {Promise<{ caseId: string, resolved: boolean }>}
 */
async function autoResolveOnAccept(args) {
  const db = getFirestore();
  const orgId = String(args.orgId || "").trim();
  const incidentId = String(args.incidentId || "").trim();
  const tokenHashPrefix = args.tokenHashPrefix ? String(args.tokenHashPrefix).trim() : "";
  const customerComment = args.customerComment ? String(args.customerComment).trim() : "";

  if (!orgId || !incidentId) return { caseId: "", resolved: false };

  // Find an open case awaiting customer review for this incident.
  const casesRef = db.collection("orgs").doc(orgId).collection("recovery_cases");
  const snap = await casesRef
    .where("incidentId", "==", incidentId)
    .where("status", "==", RECOVERY_STATUS.AWAITING_CUSTOMER)
    .limit(1)
    .get();

  if (snap.empty) return { caseId: "", resolved: false };

  const caseRef = snap.docs[0].ref;
  const caseId = snap.docs[0].id;

  const result = await db.runTransaction(async (tx) => {
    const s = await tx.get(caseRef);
    if (!s.exists) return null;
    const data = s.data() || {};
    if (data.status !== RECOVERY_STATUS.AWAITING_CUSTOMER) return null;

    const existingPkts = Array.isArray(data.packetVersions) ? data.packetVersions.slice() : [];
    // Mark the current packet version as accepted in the denorm array.
    const updatedPkts = existingPkts.map((p) => {
      if (p && p.packetVersionId === tokenHashPrefix) {
        return { ...p, outcome: "accepted", outcomeAt: new Date().toISOString() };
      }
      return p;
    });

    tx.update(caseRef, {
      packetVersions: updatedPkts,
      status: RECOVERY_STATUS.RECOVERED,
      resolvedAt: FieldValue.serverTimestamp(),
      resolution: {
        outcome: "recovered",
        resolvedBy: "customer",
        resolvedAt: FieldValue.serverTimestamp(),
        notes: customerComment
          ? `Auto-resolved on customer acceptance. Customer comment: ${customerComment}`
          : "Auto-resolved on customer acceptance.",
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { caseId, prevStatus: data.status, revenueAtRisk: data.revenueAtRisk };
  });

  if (result) {
    // PR 129a — emit packet_version_outcome on accept so the audit
    // stream captures every packet outcome (accepted/rejected/revoked)
    // through one channel.
    await writeRecoveryAudit({
      type: "packet_version_outcome",
      orgId, caseId, incidentId,
      actorUid: "customer",
      meta: { packetVersionId: tokenHashPrefix, outcome: "accepted" },
    });
    await writeRecoveryAudit({
      type: "case_status_changed",
      orgId, caseId, incidentId,
      actorUid: "customer",
      before: { status: result.prevStatus },
      after: { status: RECOVERY_STATUS.RECOVERED },
      meta: { reason: "customer_accepted_re_submission", tokenHashPrefix },
    });
    await writeRecoveryAudit({
      type: "case_resolved",
      orgId, caseId, incidentId,
      actorUid: "customer",
      meta: { outcome: "recovered", tokenHashPrefix },
    });
    await writeRecoveryAudit({
      type: "revenue_recovered",
      orgId, caseId, incidentId,
      actorUid: "customer",
      meta: { revenueAtRisk: result.revenueAtRisk || null },
    });
    console.log("[_recoveryAutoCreate] auto_resolved", { orgId, incidentId, caseId });
    return { caseId, resolved: true };
  }

  return { caseId: "", resolved: false };
}

module.exports = {
  autoCreateOrExtendCase,
  autoResolveOnAccept,
};
