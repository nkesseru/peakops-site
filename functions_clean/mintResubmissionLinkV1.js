// PEAKOPS_RECOVERY_RESUBMISSION_MINT_V1 (PR 129a)
//
// Admin/coordinator callable that mints a new customer-review link
// for a RecoveryCase that has all actions complete (status =
// ready_to_resubmit). Same token machinery as createCustomerReviewLinkV1
// (PR 126a), but the entry point is the recovery case rather than the
// incident, and the preconditions / state transitions are different:
//
// Inputs:
//   POST { orgId, caseId, actorUid?, changeSummary? }
//
// Preconditions:
//   - actor is owner/admin/supervisor/coordinator
//   - case exists at orgs/{orgId}/recovery_cases/{caseId}
//   - case.status === "ready_to_resubmit"
//   - case.incidentId resolves to a real incident
//
// Effects (transactional):
//   - Mints a new tokenized review link (re-uses PR 126 _customerReviewToken)
//   - Persists customer_review_links/{tokenHash}
//   - Appends a PacketVersionRef to case.packetVersions (with ordinal
//     = prev length + 1) and sets currentPacketVersion
//   - Transitions case → awaiting_customer
//   - Emits audit rows: case_resubmitted + case_status_changed
//
// Output (200):
//   {
//     ok: true,
//     orgId, caseId, incidentId,
//     token: "peakops_rv_...",        // cleartext, RETURNED ONCE
//     tokenHashPrefix,
//     url: "/review/<token>",
//     packetVersionId, ordinal,
//     status: "awaiting_customer",
//   }
//
// Wedge guards encoded here:
//   - This is the ONLY path that mints a resubmission. There is no
//     auto-mint; an operator click is always required.
//   - No customer notification side-effect. The cleartext URL is
//     returned to the operator and they share it however they want.
//   - changeSummary is optional, operator-authored, free text. It is
//     persisted on the packetVersion entry for audit, but is NOT
//     surfaced to the customer in this PR — PR 129c handles the
//     customer-side "since last review" copy.

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
const { resolveIncidentRef } = require("./_incidentPath");
const {
  generateToken,
  hashToken,
  hashPrefix,
} = require("./_customerReviewToken");
const {
  RECOVERY_STATUS,
  normalizeRecoveryStatus,
  canTransitionRecovery,
} = require("./recoveryState");
const {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
} = require("./incidentState");
const { writeRecoveryAudit } = require("./_recoveryAudit");
const { emitTimelineEvent } = require("./timelineEmit");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const CHANGE_SUMMARY_MAX = 1000;

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

exports.mintResubmissionLinkV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const caseId = trimStr(body.caseId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!caseId) return j(res, 400, { ok: false, error: "caseId required" });

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
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) {
      return j(res, 404, { ok: false, error: "case_not_found", caseId });
    }
    const caseData = caseSnap.data() || {};
    const currentStatus = normalizeRecoveryStatus(caseData.status);

    // Gate: only ready_to_resubmit cases can mint resubmission links.
    if (currentStatus !== RECOVERY_STATUS.READY_TO_RESUBMIT) {
      return j(res, 409, {
        ok: false,
        error: "invalid_status_for_resubmission",
        detail: `requires case status=ready_to_resubmit, got ${currentStatus}`,
        currentStatus,
      });
    }
    if (!canTransitionRecovery(currentStatus, RECOVERY_STATUS.AWAITING_CUSTOMER)) {
      // Defensive — should never hit if the enum + transitions are
      // consistent, but better to fail loud than silently corrupt state.
      return j(res, 409, {
        ok: false,
        error: "invalid_transition",
        detail: `${currentStatus} -> awaiting_customer not allowed`,
      });
    }

    const incidentId = trimStr(caseData.incidentId);
    if (!incidentId) {
      return j(res, 500, {
        ok: false,
        error: "case_missing_incident",
        detail: "case has no incidentId; cannot mint resubmission",
      });
    }
    const { ref: incRef, exists: incExists } = await resolveIncidentRef(orgId, incidentId);
    if (!incExists) {
      return j(res, 404, {
        ok: false,
        error: "incident_not_found",
        detail: "linked incident no longer exists",
        incidentId,
      });
    }
    const incSnap = await incRef.get();
    const incData = incSnap.data() || {};
    const requirements = (incData.requirements && typeof incData.requirements === "object") ? incData.requirements : {};
    const templateKey = trimStr(requirements.templateKey);
    const templateVersion = Number.isFinite(Number(requirements.templateVersion))
      ? Number(requirements.templateVersion)
      : null;
    const customerLabel = trimStr(requirements.customerLabel) || trimStr(incData.customer);
    const archetype = trimStr(requirements.archetype) || trimStr(incData.archetype);

    // Guard against double-mint races. If a prior packetVersion is
    // still "pending" in the chain, refuse — the operator should
    // revoke the outstanding link first (Phase 1 revoke endpoint).
    const existingPkts = Array.isArray(caseData.packetVersions) ? caseData.packetVersions.slice() : [];
    const outstanding = existingPkts.find((p) => trimStr(p?.outcome) === "pending");
    if (outstanding) {
      return j(res, 409, {
        ok: false,
        error: "outstanding_packet_pending",
        detail: `case already has an outstanding pending packet (${outstanding.packetVersionId}). Resolve or revoke it before minting a new one.`,
        outstandingPacketVersionId: outstanding.packetVersionId || null,
      });
    }

    // PR 129a — also transition the incident back to submitted_to_customer
    // so the customer-side accept/reject flow on the new token has a
    // legal next-state. After a first rejection, the incident sits at
    // `customer_rejected`; this resubmission flips it back to
    // `submitted_to_customer`. The transition is gated by
    // incidentState.canTransitionIncident so we don't smash a terminal
    // state by accident.
    const incCurrentStatus = normalizeIncidentStatus(incData.status);
    if (incCurrentStatus !== INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER) {
      if (!canTransitionIncident(incCurrentStatus, INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER)) {
        return j(res, 409, {
          ok: false,
          error: "incident_invalid_transition",
          detail: `incident ${incCurrentStatus} → submitted_to_customer not allowed`,
          incidentStatus: incCurrentStatus,
        });
      }
    }

    // Mint token (re-uses PR 126 machinery).
    const token = generateToken();
    const tokenHash = hashToken(token);
    const tokenHashPrefix = hashPrefix(token);

    const ordinal = existingPkts.length + 1;
    const changeSummary = sanitizeText(body.changeSummary || "", CHANGE_SUMMARY_MAX);

    // Persist the link doc. Same shape as PR 126a so getCustomerReviewV1
    // / submitCustomerReviewV1 work unchanged.
    const linkRef = db.doc(`customer_review_links/${tokenHash}`);
    await linkRef.set({
      incidentId,
      orgId,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actorUid,
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      firstAccessedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
      consumedAt: null,
      consumedAction: null,
      recentGetTimestamps: [],
      recentPostTimestamps: [],
      customerLabel,
      archetype,
      templateKey,
      templateVersion,
      // PR 129a — distinguish resubmission mints from first-mint in the
      // link doc itself, so audit + analytics queries can answer "how
      // many of our links are resubmissions?"
      sourceStatus: "resubmission",
      caseId,
      packetOrdinal: ordinal,
    });

    // Transactional case update: append packetVersion + flip status.
    // Re-read inside the txn so a concurrent mint can't double-append.
    const txnResult = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(caseRef);
      if (!fresh.exists) throw new Error("case_disappeared");
      const freshData = fresh.data() || {};
      if (normalizeRecoveryStatus(freshData.status) !== RECOVERY_STATUS.READY_TO_RESUBMIT) {
        throw new Error(`case_status_changed_mid_mint:${freshData.status}`);
      }
      const freshPkts = Array.isArray(freshData.packetVersions) ? freshData.packetVersions.slice() : [];
      // Recompute ordinal inside txn against the current chain length.
      const freshOrdinal = freshPkts.length + 1;
      const packetVersionRef = {
        packetVersionId: tokenHashPrefix,
        ordinal: freshOrdinal,
        outcome: "pending",
        outcomeAt: null,
        mintedAt: new Date().toISOString(),
        mintedBy: actorUid,
        templateVersionAtMint: templateVersion,
        ...(changeSummary ? { changeSummary } : {}),
      };
      // Idempotent: don't append if a row with this id is already there.
      const dup = freshPkts.some((p) => p && p.packetVersionId === tokenHashPrefix);
      const newPkts = dup ? freshPkts : freshPkts.concat([packetVersionRef]);
      tx.update(caseRef, {
        packetVersions: newPkts,
        currentPacketVersion: tokenHashPrefix,
        status: RECOVERY_STATUS.AWAITING_CUSTOMER,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actorUid,
      });
      return { ordinal: freshOrdinal, dup };
    });

    // PR 129a — bump the incident back to submitted_to_customer.
    // Best-effort: if this fails the case still landed correctly; the
    // operator can rerun this endpoint or fix incident state manually.
    if (incCurrentStatus !== INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER) {
      try {
        await incRef.set({
          status: INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER,
          submittedToCustomerAt: FieldValue.serverTimestamp(),
          submittedToCustomerBy: actorUid,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await emitTimelineEvent({
          orgId, incidentId,
          type: "customer_review_link_created",
          actor: "coordinator_ui",
          actorUid,
          meta: {
            tokenHashPrefix,
            templateKey,
            templateVersion,
            customerLabel,
            sourceStatus: "resubmission",
            caseId,
            packetOrdinal: txnResult.ordinal,
          },
        });
      } catch (e) {
        console.error("[mintResubmissionLinkV1] incident transition failed", e && e.message);
      }
    }

    // Audit — case_resubmitted (new in PR 129a) + status_changed.
    await writeRecoveryAudit({
      type: "case_resubmitted",
      orgId, caseId, incidentId,
      actorUid, actorRole,
      meta: {
        packetVersionId: tokenHashPrefix,
        ordinal: txnResult.ordinal,
        tokenHashPrefix,
        templateKey,
        templateVersion,
        changeSummary: changeSummary || null,
      },
    });
    await writeRecoveryAudit({
      type: "case_status_changed",
      orgId, caseId, incidentId,
      actorUid, actorRole,
      before: { status: RECOVERY_STATUS.READY_TO_RESUBMIT },
      after: { status: RECOVERY_STATUS.AWAITING_CUSTOMER },
      meta: { reason: "resubmission_link_minted", packetVersionId: tokenHashPrefix },
    });

    console.log("[mintResubmissionLinkV1] minted", {
      orgId, caseId, incidentId, tokenHashPrefix,
      ordinal: txnResult.ordinal, actorUid, actorRole,
    });

    return j(res, 200, {
      ok: true,
      orgId, caseId, incidentId,
      token,                           // cleartext — RETURNED ONCE
      tokenHashPrefix,
      url: `/review/${token}`,
      packetVersionId: tokenHashPrefix,
      ordinal: txnResult.ordinal,
      status: RECOVERY_STATUS.AWAITING_CUSTOMER,
      templateKey,
      templateVersion,
      customerLabel,
    });
  } catch (e) {
    console.error("[mintResubmissionLinkV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
