// PEAKOPS_RECOVERY_CASE_V1 (PR 127a)
//
// Admin/owner-only callable for field-by-field updates to a Recovery
// Case. Per PR 127a planning decision #2, this is the SINGLE write
// endpoint for case mutations — partial-update semantics: every body
// field is optional, only the supplied fields are touched, and each
// update writes an appropriate audit row.
//
// Supported partial updates:
//   - status         → state-machine gated transitions
//   - priority       → enum-validated
//   - cause          → primary / secondary / customerComment / operatorNotes
//   - revenueAtRisk  → amount / type / notes
//   - ownership      → owner uid + ownerRole (history append)
//   - resolution     → required when transitioning to a terminal status
//
// Resolution semantics:
//   - When status transitions to a terminal value (recovered,
//     partial_recovery, abandoned, expired), the body MUST include
//     resolution.outcome matching the target status
//   - partial_recovery additionally requires resolution.finalAmount
//     with 0 < finalAmount < case.revenueAtRisk.amount (no override
//     in MVP per planning decision #5)
//   - resolution.resolvedBy + resolvedAt are stamped server-side

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
  RECOVERY_STATUS,
  TERMINAL_STATUSES,
  REVENUE_TYPE_SET,
  RECOVERY_CAUSE_PRIMARY_SET,
  OWNER_ROLES_SET,
  canTransitionRecovery,
  normalizeRecoveryStatus,
} = require("./recoveryState");
// RECOVERY_PRIORITY_SET no longer used — priority is derived (PR 127a2).
const { writeRecoveryAudit } = require("./_recoveryAudit");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const COMMENT_MAX = 2000;
const NOTES_MAX = 2000;
const SECONDARY_MAX = 200;

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

const TERMINAL_OUTCOMES = new Set(["recovered", "partial_recovery", "abandoned", "expired"]);

exports.updateRecoveryCaseV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const caseId = trimStr(body.caseId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!caseId) return j(res, 400, { ok: false, error: "caseId required" });

    // Authz
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
    const snap = await caseRef.get();
    if (!snap.exists) {
      return j(res, 404, { ok: false, error: "case_not_found", caseId });
    }
    const before = snap.data() || {};
    const currentStatus = normalizeRecoveryStatus(before.status);

    // Build update payload + audit deltas.
    const updates = {
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    };
    const auditEvents = [];

    // ── status ─────────────────────────────────────────────────
    let statusChanged = false;
    let newStatus = currentStatus;
    if (typeof body.status === "string") {
      newStatus = normalizeRecoveryStatus(body.status);
      if (newStatus !== currentStatus) {
        if (!canTransitionRecovery(currentStatus, newStatus)) {
          return j(res, 409, {
            ok: false,
            error: "invalid_transition",
            detail: `${currentStatus} -> ${newStatus} is not a valid recovery transition`,
            currentStatus,
            attemptedStatus: newStatus,
          });
        }
        statusChanged = true;
        updates.status = newStatus;
      }
    }

    // If transitioning to a terminal status, resolution metadata is
    // required and the outcome must match.
    if (statusChanged && TERMINAL_STATUSES.has(newStatus)) {
      const resolution = (body.resolution && typeof body.resolution === "object") ? body.resolution : null;
      if (!resolution) {
        return j(res, 400, {
          ok: false,
          error: "resolution_required",
          detail: `Transitioning to ${newStatus} requires a resolution payload`,
        });
      }
      const outcome = trimStr(resolution.outcome).toLowerCase();
      if (!TERMINAL_OUTCOMES.has(outcome) || outcome !== newStatus) {
        return j(res, 400, {
          ok: false,
          error: "resolution_outcome_mismatch",
          detail: `resolution.outcome must equal target status (${newStatus})`,
        });
      }

      let finalAmount = null;
      if (newStatus === RECOVERY_STATUS.PARTIAL_RECOVERY) {
        finalAmount = Number(resolution.finalAmount);
        const currentRevenue = Number(before.revenueAtRisk && before.revenueAtRisk.amount);
        // Per planning decision #5: 0 < finalAmount < revenueAtRisk.amount; no override
        if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
          return j(res, 400, {
            ok: false,
            error: "invalid_final_amount",
            detail: "partial_recovery requires resolution.finalAmount > 0",
          });
        }
        if (!Number.isFinite(currentRevenue) || currentRevenue <= 0) {
          return j(res, 400, {
            ok: false,
            error: "no_revenue_baseline",
            detail: "partial_recovery requires the case to have revenueAtRisk.amount > 0",
          });
        }
        if (finalAmount >= currentRevenue) {
          return j(res, 400, {
            ok: false,
            error: "final_amount_not_less_than_baseline",
            detail: `resolution.finalAmount (${finalAmount}) must be < revenueAtRisk.amount (${currentRevenue}). Use 'recovered' for full recovery`,
          });
        }
      }

      updates.resolvedAt = FieldValue.serverTimestamp();
      updates.resolution = {
        outcome,
        resolvedBy: actorUid,
        resolvedAt: FieldValue.serverTimestamp(),
        ...(finalAmount != null ? { finalAmount } : {}),
        ...(resolution.notes ? { notes: sanitizeText(resolution.notes, NOTES_MAX) } : {}),
      };
      auditEvents.push({
        type: "case_resolved",
        meta: { outcome, finalAmount: finalAmount != null ? finalAmount : null },
      });
      if (outcome === "recovered" || outcome === "partial_recovery") {
        auditEvents.push({
          type: "revenue_recovered",
          meta: {
            revenueAtRisk: before.revenueAtRisk || null,
            outcome,
            finalAmount: finalAmount != null ? finalAmount : null,
          },
        });
      }
    }

    if (statusChanged) {
      auditEvents.push({
        type: "case_status_changed",
        before: { status: currentStatus },
        after: { status: newStatus },
      });
    }

    // ── priority ────────────────────────────────────────────────
    // PR 127a2 — priority is system-derived from amount + aging on
    // every read (see _recoveryPriority.js). body.priority is
    // silently ignored for backwards compat — the persisted field
    // is informational only and never read for display.
    // (Previous PR 127a behavior validated + persisted priority on
    // update; that path is intentionally removed.)
    // NOTE: revenueAtRisk changes still trigger an audit event below;
    // that's the closest analog to "priority changed" since the
    // derived priority shifts with amount.

    // ── cause (partial) ─────────────────────────────────────────
    if (body.cause && typeof body.cause === "object") {
      const causeUpdates = {};
      const beforeCause = before.cause || {};
      if (typeof body.cause.primary === "string") {
        const p = trimStr(body.cause.primary).toLowerCase();
        if (p && !RECOVERY_CAUSE_PRIMARY_SET.has(p)) {
          return j(res, 400, {
            ok: false,
            error: "invalid_cause_primary",
            detail: "cause.primary must be one of the 10 known causes",
          });
        }
        if (p && p !== String(beforeCause.primary || "")) {
          causeUpdates["cause.primary"] = p;
          causeUpdates["cause.categorizedBy"] = actorUid;
          causeUpdates["cause.categorizedAt"] = FieldValue.serverTimestamp();
          // PR 128a — operator just manually set cause.primary; clear
          // the "inferred from customer comment" marker so the UI
          // stops showing it.
          causeUpdates["cause.inferredFromComment"] = false;
          // PR 129a — auto-transition to `triaged` dropped (state
          // collapsed into `open`). The cause field itself is the
          // signal that triage happened.
        }
      }
      if (typeof body.cause.secondary === "string") {
        causeUpdates["cause.secondary"] = sanitizeText(body.cause.secondary, SECONDARY_MAX);
      }
      if (typeof body.cause.customerComment === "string") {
        causeUpdates["cause.customerComment"] = sanitizeText(body.cause.customerComment, COMMENT_MAX);
      }
      if (typeof body.cause.operatorNotes === "string") {
        causeUpdates["cause.operatorNotes"] = sanitizeText(body.cause.operatorNotes, NOTES_MAX);
      }
      Object.assign(updates, causeUpdates);
    }

    // ── revenueAtRisk (partial) ─────────────────────────────────
    if (body.revenueAtRisk && typeof body.revenueAtRisk === "object") {
      const rev = body.revenueAtRisk;
      const revUpdates = {};
      if (rev.amount !== undefined) {
        const amt = Number(rev.amount);
        if (!Number.isFinite(amt) || amt < 0) {
          return j(res, 400, {
            ok: false,
            error: "invalid_revenue_amount",
            detail: "revenueAtRisk.amount must be a non-negative number",
          });
        }
        revUpdates["revenueAtRisk.amount"] = amt;
      }
      if (typeof rev.type === "string") {
        const t = trimStr(rev.type).toLowerCase();
        if (!REVENUE_TYPE_SET.has(t)) {
          return j(res, 400, {
            ok: false,
            error: "invalid_revenue_type",
            detail: "revenueAtRisk.type must be actual, estimated, or unknown",
          });
        }
        revUpdates["revenueAtRisk.type"] = t;
      }
      if (typeof rev.notes === "string") {
        revUpdates["revenueAtRisk.notes"] = sanitizeText(rev.notes, NOTES_MAX);
      }
      if (Object.keys(revUpdates).length > 0) {
        revUpdates["revenueAtRisk.enteredBy"] = actorUid;
        revUpdates["revenueAtRisk.enteredAt"] = FieldValue.serverTimestamp();
        Object.assign(updates, revUpdates);
        auditEvents.push({
          type: "case_revenue_updated",
          before: { revenueAtRisk: before.revenueAtRisk || null },
          after: { revenueAtRisk: revUpdates },
        });
      }
    }

    // ── ownership ───────────────────────────────────────────────
    if (body.ownership && typeof body.ownership === "object") {
      const newOwner = trimStr(body.ownership.owner || "");
      const newRole = trimStr(body.ownership.ownerRole || "").toLowerCase();
      if (newRole && !OWNER_ROLES_SET.has(newRole)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_owner_role",
          detail: "ownerRole must be coordinator, supervisor, field_lead, or manager",
        });
      }
      const prevOwner = String((before.ownership && before.ownership.owner) || "");
      const prevRole = String((before.ownership && before.ownership.ownerRole) || "");
      if ((newOwner && newOwner !== prevOwner) || (newRole && newRole !== prevRole)) {
        const historyEntry = {
          uid: prevOwner,
          role: prevRole,
          fromTs: (before.ownership && before.ownership.assignedAt) || null,
          toTs: new Date().toISOString(),
        };
        updates["ownership.owner"] = newOwner || prevOwner;
        if (newRole) updates["ownership.ownerRole"] = newRole;
        updates["ownership.assignedAt"] = FieldValue.serverTimestamp();
        updates["ownership.assignedBy"] = actorUid;
        updates["ownership.history"] = FieldValue.arrayUnion(historyEntry);
        auditEvents.push({
          type: "case_assigned",
          before: { owner: prevOwner, ownerRole: prevRole },
          after: { owner: newOwner || prevOwner, ownerRole: newRole || prevRole },
        });
      }
    }

    if (Object.keys(updates).length <= 2) {
      // Only updatedAt + updatedBy — nothing meaningful changed.
      return j(res, 200, {
        ok: true,
        orgId, caseId,
        noop: true,
        status: currentStatus,
      });
    }

    await caseRef.update(updates);

    for (const ev of auditEvents) {
      await writeRecoveryAudit({
        ...ev,
        orgId, caseId,
        incidentId: before.incidentId,
        actorUid, actorRole,
      });
    }

    console.log("[updateRecoveryCaseV1] updated", {
      orgId, caseId, actorUid, audits: auditEvents.map(e => e.type),
    });

    return j(res, 200, {
      ok: true,
      orgId, caseId,
      status: updates.status || currentStatus,
      auditCount: auditEvents.length,
    });
  } catch (e) {
    console.error("[updateRecoveryCaseV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
