// PEAKOPS_RECOVERY_ACTION_V1 (PR 127a)
//
// Admin/owner-only callable for field-by-field updates to a Recovery
// Action. Same partial-update discipline as updateRecoveryCaseV1.
//
// Supported updates:
//   - status        → enum-validated; stamps startedAt/completedAt
//                     when transitioning to in_progress/done respectively
//   - assignee      → uid + optional assigneeRole
//   - dueAt         → ISO timestamp, informational only (no SLA enforcement)
//   - title / description (post-creation edits)
//   - outcome (on completion)
//   - blockingReason (when status=blocked)
//   - evidence (append additional evidence ids; validated)

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const {
  RECOVERY_ACTION_STATUS_SET,
  OWNER_ROLES_SET,
  RECOVERY_STATUS,
  canTransitionRecovery,
} = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");

// PR 129a — action statuses that count as "open work" for the
// ready-to-resubmit gate. If after the update zero actions remain in
// any of these statuses, AND ≥1 action has ever existed on the case,
// the case auto-transitions to `ready_to_resubmit`.
const OPEN_ACTION_STATUSES = new Set(["open", "in_progress", "blocked"]);

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const OUTCOME_MAX = 2000;
const BLOCKING_MAX = 500;

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

function sanitizeText(raw, maxLen) {
  const s = String(raw || "").replace(/[\x00-\x1F\x7F]/g, "").trim();
  return s.slice(0, maxLen);
}

async function validateEvidenceIds(db, orgId, incidentId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { valid: [], invalid: [] };
  const canonicalEv = db
    .collection("orgs").doc(orgId)
    .collection("incidents").doc(incidentId)
    .collection("evidence_locker");
  const legacyEv = db.collection("incidents").doc(incidentId).collection("evidence_locker");

  const valid = [];
  const invalid = [];
  for (const id of ids) {
    const cleanId = trimStr(id);
    if (!cleanId) { invalid.push(id); continue; }
    const [cSnap, lSnap] = await Promise.all([
      canonicalEv.doc(cleanId).get().catch(() => null),
      legacyEv.doc(cleanId).get().catch(() => null),
    ]);
    if ((cSnap && cSnap.exists) || (lSnap && lSnap.exists)) valid.push(cleanId);
    else invalid.push(cleanId);
  }
  return { valid, invalid };
}

exports.updateRecoveryActionV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const caseId = trimStr(body.caseId);
    const actionId = trimStr(body.actionId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!caseId) return j(res, 400, { ok: false, error: "caseId required" });
    if (!actionId) return j(res, 400, { ok: false, error: "actionId required" });

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    const db = getFirestore();
    const caseRef = db.collection("orgs").doc(orgId).collection("recovery_cases").doc(caseId);
    const actionRef = caseRef.collection("actions").doc(actionId);

    const [caseSnap, actionSnap] = await Promise.all([caseRef.get(), actionRef.get()]);
    if (!caseSnap.exists) return j(res, 404, { ok: false, error: "case_not_found", caseId });
    if (!actionSnap.exists) return j(res, 404, { ok: false, error: "action_not_found", actionId });
    const before = actionSnap.data() || {};
    const incidentId = trimStr((caseSnap.data() || {}).incidentId);

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    const auditEvents = [];

    // ── status ─────────────────────────────────────────────────
    if (typeof body.status === "string") {
      const newStatus = trimStr(body.status).toLowerCase();
      if (!RECOVERY_ACTION_STATUS_SET.has(newStatus)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_action_status",
          detail: `status must be one of: ${Array.from(RECOVERY_ACTION_STATUS_SET).join(", ")}`,
        });
      }
      if (newStatus !== String(before.status || "")) {
        updates.status = newStatus;
        // Stamp lifecycle timestamps.
        if (newStatus === "in_progress" && !before.startedAt) {
          updates.startedAt = FieldValue.serverTimestamp();
        }
        if (newStatus === "done" || newStatus === "skipped") {
          updates.completedAt = FieldValue.serverTimestamp();
        }
        auditEvents.push({
          type: newStatus === "done" ? "action_completed" : "action_status_changed",
          before: { status: before.status },
          after: { status: newStatus },
        });
      }
    }

    // ── assignee / role ─────────────────────────────────────────
    if (typeof body.assignee === "string" || typeof body.assigneeRole === "string") {
      const newAssignee = trimStr(body.assignee || "");
      const newRole = trimStr(body.assigneeRole || "").toLowerCase();
      if (newRole && !OWNER_ROLES_SET.has(newRole)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_assignee_role",
          detail: "assigneeRole must be coordinator, supervisor, field_lead, or manager",
        });
      }
      const prevAssignee = String(before.assignee || "");
      const prevRole = String(before.assigneeRole || "");
      if ((newAssignee && newAssignee !== prevAssignee) || (newRole && newRole !== prevRole)) {
        if (newAssignee) updates.assignee = newAssignee;
        if (newRole) updates.assigneeRole = newRole;
        auditEvents.push({
          type: "action_assigned",
          before: { assignee: prevAssignee, assigneeRole: prevRole },
          after: {
            assignee: newAssignee || prevAssignee,
            assigneeRole: newRole || prevRole,
          },
        });
      }
    }

    // ── title / description / outcome / blockingReason ─────────
    if (typeof body.title === "string") {
      const t = sanitizeText(body.title, TITLE_MAX);
      if (t) updates.title = t;
    }
    if (typeof body.description === "string") {
      updates.description = sanitizeText(body.description, DESCRIPTION_MAX);
    }
    if (typeof body.outcome === "string") {
      updates.outcome = sanitizeText(body.outcome, OUTCOME_MAX);
    }
    if (typeof body.blockingReason === "string") {
      updates.blockingReason = sanitizeText(body.blockingReason, BLOCKING_MAX);
    }

    // ── dueAt ─────────────────────────────────────────────────
    if (typeof body.dueAt === "string") {
      const d = new Date(body.dueAt);
      if (!Number.isNaN(d.getTime())) {
        updates.dueAt = d.toISOString();
      }
    }

    // ── evidence (append) ──────────────────────────────────────
    if (Array.isArray(body.addEvidenceIds) && body.addEvidenceIds.length > 0) {
      const { valid, invalid } = await validateEvidenceIds(db, orgId, incidentId, body.addEvidenceIds);
      if (invalid.length > 0) {
        return j(res, 400, {
          ok: false,
          error: "invalid_evidence",
          detail: "Some evidence ids don't exist on the linked incident's evidence_locker",
          invalidIds: invalid,
        });
      }
      const newEntries = valid.map((id) => ({
        evidenceId: id,
        addedBy: actorUid,
        addedAt: new Date().toISOString(),
      }));
      updates.evidence = FieldValue.arrayUnion(...newEntries);
    }

    if (Object.keys(updates).length <= 1) {
      return j(res, 200, { ok: true, orgId, caseId, actionId, noop: true });
    }

    await actionRef.update(updates);

    // Touch case updatedAt so list views reflect activity.
    await caseRef.update({
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    });

    for (const ev of auditEvents) {
      await writeRecoveryAudit({
        ...ev,
        orgId, caseId, incidentId,
        actionId,
        actorUid, actorRole,
      });
    }

    // PR 129a — Auto-transition gate. If this update moved an action to
    // a terminal action-status (done/skipped) and zero actions on the
    // case remain open/in_progress/blocked, flip the case to
    // ready_to_resubmit so the operator's CTA becomes "Mint Resubmission
    // Link." Idempotent on retry — if the case is already at
    // ready_to_resubmit (or beyond), we skip silently.
    let autoFlipped = false;
    try {
      const movedToTerminal = updates.status === "done" || updates.status === "skipped";
      if (movedToTerminal) {
        // Re-read case status fresh inside the gate (the caseSnap above
        // was pre-update; another concurrent action could have flipped
        // state in the meantime).
        const freshCaseSnap = await caseRef.get();
        const freshStatus = String((freshCaseSnap.data() || {}).status || "");
        const eligibleFrom =
          freshStatus === RECOVERY_STATUS.OPEN ||
          freshStatus === RECOVERY_STATUS.IN_PROGRESS;
        if (eligibleFrom && canTransitionRecovery(freshStatus, RECOVERY_STATUS.READY_TO_RESUBMIT)) {
          // Count remaining open actions on the case. Pre-write action
          // update is already persisted at this point, so the query
          // reflects the just-applied change.
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
          if (totalActions > 0 && openCount === 0) {
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
            autoFlipped = true;
            console.log("[updateRecoveryActionV1] auto_flipped_ready_to_resubmit", {
              orgId, caseId, totalActions, doneCount, skippedCount,
            });
          }
        }
      }
    } catch (e) {
      // Best-effort; never fail the action update.
      console.error("[updateRecoveryActionV1] auto-transition failed", e && e.message);
    }

    return j(res, 200, {
      ok: true,
      orgId, caseId, actionId,
      auditCount: auditEvents.length,
      caseAutoFlippedToReadyToResubmit: autoFlipped,
    });
  } catch (e) {
    console.error("[updateRecoveryActionV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
