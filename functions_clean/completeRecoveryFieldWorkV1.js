// PEAKOPS_RECOVERY_FOREMAN_COMPLETE_V1 (PR 130a)
//
// Foreman-facing wrapper for completing field-level recovery work.
// Mirrors a narrow slice of updateRecoveryActionV1, but with two
// fundamental differences:
//
//   1. Authz is per-action: caller must be the specific assignee OR
//      have a membership role authorized to act on field_lead-assigned
//      actions. Coordinators / admins use updateRecoveryActionV1 — this
//      wrapper is for FIELD users.
//
//   2. Surface area is intentionally narrow: status (in_progress|done),
//      addEvidenceIds, outcome (free text). No title/description edits,
//      no assignee changes, no blocking, no skipping — those are
//      coordinator decisions.
//
// On a successful "done" status, the shared _recoveryAutoFlip helper
// fires the same case_ready_for_resubmission auto-transition as the
// coordinator path. The coordinator's UI updates without intervention.
//
// Architecture lock (PR 129 review):
//   Foreman never sees RecoveryCase. The endpoint takes incidentId +
//   actionId (NOT caseId). We look up the case from the incident.

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { TERMINAL_STATUSES } = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");
const { tryAutoFlipToReadyToResubmit } = require("./_recoveryAutoFlip");
const { FIELD_WORK_ROLES, isVisibleToActor } = require("./listRecoveryActionsForIncidentV1");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const OUTCOME_MAX = 2000;

// PR 130a — Foreman can only push an action toward completion. Blocking
// or skipping is a coordinator decision (use updateRecoveryActionV1).
const ALLOWED_STATUSES = new Set(["in_progress", "done"]);

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

exports.completeRecoveryFieldWorkV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const incidentId = trimStr(body.incidentId);
    const actionId = trimStr(body.actionId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!incidentId) return j(res, 400, { ok: false, error: "incidentId required" });
    if (!actionId) return j(res, 400, { ok: false, error: "actionId required" });

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    const db = getFirestore();

    // Find the active case for this incident. Foreman never references
    // caseId directly — they only know incidentId + actionId.
    const casesSnap = await db
      .collection("orgs").doc(orgId).collection("recovery_cases")
      .where("incidentId", "==", incidentId)
      .limit(1)
      .get();
    if (casesSnap.empty) {
      return j(res, 404, { ok: false, error: "no_active_case_for_incident" });
    }
    const caseRef = casesSnap.docs[0].ref;
    const caseData = casesSnap.docs[0].data() || {};
    const caseId = casesSnap.docs[0].id;

    if (TERMINAL_STATUSES.has(String(caseData.status || ""))) {
      return j(res, 409, {
        ok: false,
        error: "case_terminal",
        detail: "Case is closed; no further field work accepted.",
      });
    }

    const actionRef = caseRef.collection("actions").doc(actionId);
    const actionSnap = await actionRef.get();
    if (!actionSnap.exists) {
      return j(res, 404, { ok: false, error: "action_not_found", actionId });
    }
    const beforeAction = actionSnap.data() || {};

    // PR 130a — Per-action authz: actor must be the specific assignee
    // OR have a membership role authorized for field_lead work. This
    // is the foreman gate (separate from the org-level read gate above).
    if (!isVisibleToActor(beforeAction, actorUid, actorRole)) {
      return j(res, 403, {
        ok: false,
        error: "not_authorized_for_action",
        detail: "You are not the assignee for this work, and your role does not cover its assigneeRole.",
        actorRole,
      });
    }

    // ── Build update ──────────────────────────────────────────────
    const updates = { updatedAt: FieldValue.serverTimestamp() };
    const auditEvents = [];

    // ── status ─────────────────────────────────────────────────────
    if (typeof body.status === "string") {
      const newStatus = trimStr(body.status).toLowerCase();
      if (!ALLOWED_STATUSES.has(newStatus)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_status_for_field_work",
          detail: `Field work can only move to ${Array.from(ALLOWED_STATUSES).join(" or ")}. Use the admin endpoint for other transitions.`,
        });
      }
      if (newStatus !== String(beforeAction.status || "")) {
        updates.status = newStatus;
        if (newStatus === "in_progress" && !beforeAction.startedAt) {
          updates.startedAt = FieldValue.serverTimestamp();
        }
        if (newStatus === "done") {
          updates.completedAt = FieldValue.serverTimestamp();
        }
        auditEvents.push({
          type: newStatus === "done" ? "action_completed" : "action_status_changed",
          before: { status: beforeAction.status },
          after: { status: newStatus },
        });
      }
    }

    // ── outcome (on done) ──────────────────────────────────────────
    if (typeof body.outcome === "string") {
      updates.outcome = sanitizeText(body.outcome, OUTCOME_MAX);
    }

    // ── evidence (append) ──────────────────────────────────────────
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
      return j(res, 200, { ok: true, orgId, incidentId, actionId, noop: true });
    }

    await actionRef.update(updates);

    // Touch case so list views reflect activity. Note: the caller
    // (foreman) never sees the case; this is for the coordinator's
    // recovery list / detail surface.
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
        // PR 130a — mark every foreman-side write so audit reports can
        // separate field activity from coordinator activity.
        meta: { ...(ev.meta || {}), source: "field_work_endpoint" },
      });
    }

    // PR 129a / 130a — Auto-transition gate shared with
    // updateRecoveryActionV1 via _recoveryAutoFlip.
    const autoFlipped = await tryAutoFlipToReadyToResubmit({
      caseRef, orgId, caseId, incidentId,
      actionId,
      newActionStatus: updates.status,
    });

    return j(res, 200, {
      ok: true,
      orgId, incidentId, actionId,
      // PR 130a — foreman doesn't get caseId in the success response;
      // they don't need it for any subsequent UI flow.
      auditCount: auditEvents.length,
      caseAutoFlippedToReadyToResubmit: autoFlipped,
    });
  } catch (e) {
    console.error("[completeRecoveryFieldWorkV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
