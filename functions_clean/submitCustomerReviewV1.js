// PEAKOPS_CUSTOMER_REVIEW_LINK_V1 (PR 126a)
//
// Token-only callable. Customer hits Accept or Request Correction.
//
// Inputs:
//   POST {
//     token: "peakops_rv_...",
//     action: "accept" | "reject",
//     comment?: string        // required on reject; optional on accept
//   }
//
// Outputs (200):
//   {
//     ok: true,
//     tokenHashPrefix,
//     action: "accepted" | "rejected",
//     status: "customer_accepted" | "customer_rejected"
//   }
//
// Failure modes:
//   400 missing_token / malformed_token / missing_action / invalid_action / comment_required
//   404 token_not_found / incident_not_found
//   409 already_consumed (terminal action already taken on this token)
//   410 token_revoked
//   429 rate_limited / post_hard_cap_reached
//
// Per-token sliding window: 5 POSTs / 60s. Hard cap: 5 total POSTs
// across the token's lifetime — after 5 attempts the token is locked
// regardless of consumption status.
//
// On success:
//   - link.consumedAt / consumedAction set (one-shot)
//   - incident.status → customer_accepted | customer_rejected
//   - timeline event written (canonical incident path)
//   - cross-incident audit row written (orgs/{orgId}/customer_review_audit)

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveIncidentRef } = require("./_incidentPath");
const {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
} = require("./incidentState");
const {
  isWellFormed,
  hashToken,
  hashPrefix,
  ipPrefixFromRequest,
  userAgentFingerprint,
  isExpired,
} = require("./_customerReviewToken");
const { emitTimelineEvent } = require("./timelineEmit");
// PR 127a — inline call to recovery auto-create on reject + auto-resolve on accept.
// Best-effort: any failure inside the recovery helpers is swallowed; the
// customer-side action still succeeds. Audit gaps surface in logs.
const { autoCreateOrExtendCase, autoResolveOnAccept } = require("./_recoveryAutoCreate");

if (!admin.apps.length) admin.initializeApp();

const POST_WINDOW_MS = 60 * 1000;
const POST_LIMIT_PER_WINDOW = 5;
const POST_HARD_CAP = 5;             // Total lifetime attempts.
const COMMENT_MAX = 2000;

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

function sanitizeComment(raw) {
  const s = String(raw || "").replace(/[\x00-\x1F\x7F]/g, "").trim();
  return s.slice(0, COMMENT_MAX);
}

exports.submitCustomerReviewV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const token = trimStr(body.token);
    if (!token) return j(res, 400, { ok: false, error: "missing_token" });
    if (!isWellFormed(token)) {
      return j(res, 404, { ok: false, error: "token_not_found" });
    }

    const rawAction = trimStr(body.action).toLowerCase();
    if (!rawAction) return j(res, 400, { ok: false, error: "missing_action" });
    if (rawAction !== "accept" && rawAction !== "reject") {
      return j(res, 400, { ok: false, error: "invalid_action", detail: "action must be 'accept' or 'reject'" });
    }
    const finalAction = rawAction === "accept" ? "accepted" : "rejected";
    const targetStatus = finalAction === "accepted"
      ? INCIDENT_STATUS.CUSTOMER_ACCEPTED
      : INCIDENT_STATUS.CUSTOMER_REJECTED;

    const comment = sanitizeComment(body.comment);
    if (finalAction === "rejected" && comment.length === 0) {
      return j(res, 400, {
        ok: false,
        error: "comment_required",
        detail: "A comment is required when requesting a correction.",
      });
    }

    const tokenHash = hashToken(token);
    const tokenHashPrefix = hashPrefix(token);

    const db = getFirestore();
    const linkRef = db.doc(`customer_review_links/${tokenHash}`);

    // Capture rate-limit / consumption decisions atomically. The same
    // transaction also flags the link as consumed so concurrent accept
    // + reject requests can't both succeed.
    let linkData = null;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(linkRef);
        if (!snap.exists) {
          const err = new Error("token_not_found");
          err.statusCode = 404;
          throw err;
        }
        const data = snap.data() || {};

        if (data.revokedAt) {
          const err = new Error("token_revoked");
          err.statusCode = 410;
          throw err;
        }
        // PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 (Chunk 1, 2026-06-22)
        // Expired tokens cannot submit a decision. 410 Gone matches
        // the revoked-token shape so customer-side error handling is
        // uniform; the discriminator is the `error` field.
        if (isExpired(data.expiresAt)) {
          const err = new Error("token_expired");
          err.statusCode = 410;
          throw err;
        }
        if (data.consumedAt) {
          const err = new Error("already_consumed");
          err.statusCode = 409;
          err.details = {
            consumedAction: data.consumedAction || null,
            consumedAt: data.consumedAt || null,
          };
          throw err;
        }

        // Sliding-window + hard-cap rate limit.
        const now = Date.now();
        const recentAll = Array.isArray(data.recentPostTimestamps) ? data.recentPostTimestamps.slice() : [];
        const recent = recentAll.filter((t) => Number.isFinite(Number(t)) && (now - Number(t)) < POST_WINDOW_MS);
        if (recent.length >= POST_LIMIT_PER_WINDOW) {
          const err = new Error("rate_limited");
          err.statusCode = 429;
          throw err;
        }
        // Hard lifetime cap — once you've used your 5 attempts, the
        // token is done. Belt-and-braces against runaway abuse.
        if (recentAll.length >= POST_HARD_CAP) {
          const err = new Error("post_hard_cap_reached");
          err.statusCode = 429;
          throw err;
        }
        recent.push(now);
        const recentWithNew = recentAll.slice();
        recentWithNew.push(now);

        // Mark consumed inside the same transaction so a second
        // request can't claim the link.
        // PEAKOPS_REVIEW_VERSION_PIN_V3 (2026-06-15)
        // Capture the link's pinnedPacket (written at mint by slice 1)
        // and durably record it as `reviewedPacket` on the same atomic
        // write that flips consumedAt. The audit fact "what bytes did
        // the customer act on" is now stored on the link doc itself
        // — independent of incident state drift.
        // Pre-slice-1 links carry no pinnedPacket → reviewedPacket
        // is omitted from the update (link still consumes cleanly).
        const _pp = (data && typeof data.pinnedPacket === "object")
          ? data.pinnedPacket : null;
        const _reviewedPacket = (_pp && Number.isFinite(Number(_pp.version)))
          ? {
              version: Number(_pp.version),
              fileName: trimStr(_pp.fileName),
              storagePath: trimStr(_pp.storagePath),
              bucket: trimStr(_pp.bucket),
              zipSha256: trimStr(_pp.zipSha256),
              originalRecordHash: trimStr(_pp.originalRecordHash),
              generatedAt: trimStr(_pp.generatedAt),
              pinnedAt: _pp.pinnedAt || null,
              reviewedAt: FieldValue.serverTimestamp(),
              action: finalAction,
            }
          : null;
        const _linkUpdates = {
          recentPostTimestamps: recentWithNew,
          consumedAt: FieldValue.serverTimestamp(),
          consumedAction: finalAction,
          consumedComment: comment || null,
        };
        if (_reviewedPacket) _linkUpdates.reviewedPacket = _reviewedPacket;
        tx.update(linkRef, _linkUpdates);
        linkData = data;
      });
    } catch (e) {
      const code = e?.statusCode || 500;
      const errStr = String(e?.message || "internal_error");
      const extras = e && e.details ? e.details : {};
      return j(res, code, { ok: false, error: errStr, tokenHashPrefix, ...extras });
    }

    // Out-of-transaction work: update incident, emit timeline, write
    // audit row. If any of these fail, the link is already marked
    // consumed so the customer can't double-submit; coordinator-side
    // remediation handles partial failure.
    const orgId = trimStr(linkData && linkData.orgId);
    const incidentId = trimStr(linkData && linkData.incidentId);

    const { ref: incRef, exists: incExists } = await resolveIncidentRef(orgId, incidentId);
    if (!incExists) {
      console.error("[submitCustomerReviewV1] incident_not_found post-consume", { orgId, incidentId, tokenHashPrefix });
      return j(res, 404, { ok: false, error: "incident_not_found", tokenHashPrefix });
    }
    const incSnap = await incRef.get();
    const incData = incSnap.data() || {};
    const currentStatus = normalizeIncidentStatus(incData.status);

    if (!canTransitionIncident(currentStatus, targetStatus)) {
      // Edge case: incident transitioned out from under us (admin
      // moved it). Log and return; link is consumed so the customer
      // sees a clean response.
      console.warn("[submitCustomerReviewV1] cannot_transition", {
        currentStatus, targetStatus, orgId, incidentId, tokenHashPrefix,
      });
      return j(res, 409, {
        ok: false,
        error: "invalid_transition",
        detail: `${currentStatus} -> ${targetStatus} not allowed`,
        tokenHashPrefix,
      });
    }

    // PEAKOPS_REVIEW_VERSION_PIN_V3 (2026-06-15)
    // Mirror the version-pinned identifiers onto the incident doc's
    // existing customer-acceptance summary fields. Operator-facing
    // surfaces (slice 4 panel, future reporting) can answer
    // "which packet did the customer act on?" without a join to
    // customer_review_links. Pre-slice-1 links → fields omitted.
    const _ppOut = (linkData && linkData.pinnedPacket && Number.isFinite(Number(linkData.pinnedPacket.version)))
      ? linkData.pinnedPacket : null;
    const incUpdate = {
      status: targetStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (finalAction === "accepted") {
      incUpdate.customerAcceptedAt = FieldValue.serverTimestamp();
      incUpdate.customerAcceptanceComment = comment || null;
      if (_ppOut) {
        incUpdate.customerAcceptedPacketVersion = Number(_ppOut.version);
        incUpdate.customerAcceptedPacketHash = trimStr(_ppOut.zipSha256);
      }
    } else {
      incUpdate.customerRejectedAt = FieldValue.serverTimestamp();
      incUpdate.customerRejectionComment = comment;
      if (_ppOut) {
        incUpdate.customerRejectedPacketVersion = Number(_ppOut.version);
        incUpdate.customerRejectedPacketHash = trimStr(_ppOut.zipSha256);
      }
    }
    await incRef.set(incUpdate, { merge: true });

    // Timeline event (incident-level).
    // PEAKOPS_REVIEW_VERSION_PIN_V3 — meta.packetVersion + meta.packetHash
    // so the audit trail records which packet was acted on. Null for
    // pre-slice-1 links.
    await emitTimelineEvent({
      orgId,
      incidentId,
      type: finalAction === "accepted" ? "customer_accepted" : "customer_rejected",
      actor: "customer",
      meta: {
        tokenHashPrefix,
        userAgentFingerprint: userAgentFingerprint(req),
        ipPrefix: ipPrefixFromRequest(req),
        comment: comment || null,
        packetVersion: _ppOut ? Number(_ppOut.version) : null,
        packetHash: _ppOut ? (trimStr(_ppOut.zipSha256) || null) : null,
      },
    });

    // Cross-incident audit row.
    // PEAKOPS_REVIEW_VERSION_PIN_V3 — packetVersion + packetHash in the
    // audit row so external reporting can answer "which packet did the
    // customer accept?" without joining customer_review_links.
    try {
      await db
        .collection("orgs").doc(orgId)
        .collection("customer_review_audit")
        .add({
          type: finalAction === "accepted" ? "customer_accepted" : "customer_rejected",
          orgId,
          incidentId,
          templateKey: linkData.templateKey || null,
          templateVersion: linkData.templateVersion || null,
          actorKind: "customer",
          tokenHashPrefix,
          comment: comment || null,
          userAgentFingerprint: userAgentFingerprint(req),
          ipPrefix: ipPrefixFromRequest(req),
          packetVersion: _ppOut ? Number(_ppOut.version) : null,
          packetHash: _ppOut ? (trimStr(_ppOut.zipSha256) || null) : null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (e) {
      console.error("[submitCustomerReviewV1] audit write failed", e && e.message);
    }

    console.log("[submitCustomerReviewV1] customer_action", {
      orgId, incidentId, tokenHashPrefix, finalAction, targetStatus,
    });

    // PEAKOPS_CUSTOMER_DECISION_NOTIFY_V1 (Chunk 2: Workflow Completion, 2026-06-22)
    // When the customer acts on the review link, fan out an in-app
    // notification so the operator team sees the decision immediately
    // instead of polling /summary. Reject path is especially important
    // — a recovery case has just been auto-created and the operator
    // needs to know rework is required. Best-effort; never blocks
    // the customer response.
    try {
      let _notify = null;
      try { _notify = require("./_notify"); } catch (_) { /* optional */ }
      if (_notify && typeof _notify.fanOutOrgNotification === "function") {
        const _displayCustomer = (linkData && linkData.customerLabel) || "the customer";
        const _creatorUid = (linkData && linkData.createdBy) || "";
        const isAccept = finalAction === "accepted";
        const result = await _notify.fanOutOrgNotification({
          orgId,
          recipientRoles: ["admin", "supervisor"],
          additionalUids: _creatorUid ? [_creatorUid] : [],
          payload: {
            type: isAccept ? "customer_accepted" : "customer_rejected",
            title: isAccept ? "Customer accepted" : "Customer requested correction",
            message: isAccept
              ? `${_displayCustomer} accepted the packet. Record is complete.`
              : `${_displayCustomer} requested a correction. Recovery case opened.`,
            incidentId,
            orgId,
            targetUrl: `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}`,
          },
        });
        const wrote = typeof result === "number" ? result : (result?.wrote || 0);
        const recipients = typeof result === "number" ? result : (result?.recipients || result?.wrote || 0);
        console.log(`[notify] ${isAccept ? "customer_accepted" : "customer_rejected"} recipients=${recipients} wrote=${wrote}`);
      }
    } catch (e) {
      console.warn("[submitCustomerReviewV1] notify failed", e && e.message);
    }

    // PR 127a — Inline recovery handling. Best-effort; never fails the
    // customer-side action. Two paths:
    //   reject → auto-create new case OR extend existing one
    //   accept → auto-resolve any awaiting_customer case
    try {
      const packetVersionRef = {
        packetVersionId: tokenHashPrefix,
        outcome: finalAction,
        outcomeAt: new Date().toISOString(),
        customerComment: comment || null,
        templateVersionAtMint: linkData && Number.isFinite(Number(linkData.templateVersion))
          ? Number(linkData.templateVersion) : null,
      };
      if (finalAction === "rejected") {
        const r = await autoCreateOrExtendCase({
          orgId, incidentId,
          source: "customer_rejected",
          actorUid: (linkData && linkData.createdBy) || "system",
          tokenHashPrefix,
          customerComment: comment || "",
          packetVersion: packetVersionRef,
        });
        console.log("[submitCustomerReviewV1] recovery_auto_handled", {
          orgId, incidentId, caseId: r.caseId, created: r.created,
        });
      } else if (finalAction === "accepted") {
        const r = await autoResolveOnAccept({
          orgId, incidentId,
          tokenHashPrefix,
          customerComment: comment || "",
        });
        if (r.resolved) {
          console.log("[submitCustomerReviewV1] recovery_auto_resolved", {
            orgId, incidentId, caseId: r.caseId,
          });
        }
      }
    } catch (e) {
      console.error("[submitCustomerReviewV1] recovery_auto_handler failed", e && e.message);
    }

    return j(res, 200, {
      ok: true,
      tokenHashPrefix,
      action: finalAction,
      status: targetStatus,
    });
  } catch (e) {
    console.error("[submitCustomerReviewV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
