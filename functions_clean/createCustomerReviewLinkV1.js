// PEAKOPS_CUSTOMER_REVIEW_LINK_V1 (PR 126a)
//
// Admin/Owner-only callable that mints a tokenized review link for a
// single incident and transitions the incident from `in_progress` to
// `submitted_to_customer`.
//
// Inputs:
//   POST { orgId, incidentId, actorUid? }
//
// Preconditions:
//   - actor has role owner or admin
//   - incident exists at canonical OR legacy path
//   - incident.status === "in_progress"
//   - every job on the incident has reviewStatus === "approved" OR status === "approved"
//     (same gate as closeIncidentV1)
//
// Output (200):
//   {
//     ok: true,
//     orgId, incidentId,
//     token: "peakops_rv_...",        // cleartext, RETURNED ONCE
//     tokenHashPrefix: "abcd1234",    // for log correlation
//     url: "/review/<token>",         // relative; UI composes the full URL
//     status: "submitted_to_customer",
//     templateVersion, templateKey,
//     createdAt: <iso>
//   }
//
// Side effects:
//   - writes orgs/{orgId}/customer_review_links/{tokenHash}
//   - updates incident.status -> submitted_to_customer
//   - emits incident timeline event `customer_review_link_created`
//   - appends to orgs/{orgId}/customer_review_audit
//
// The cleartext token is never stored. Lost cleartext == revoke + re-mint.

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
// PR 133C — enforcement / blocking mode for compliance violations.
const {
  evaluateEnforcement,
  parseOverride,
  recordBlockTriggered,
  recordBlockOverridden,
  _evidenceTypesFromList,
} = require("./_enforcement");
const {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
} = require("./incidentState");
const {
  generateToken,
  hashToken,
  hashPrefix,
  computeExpiresAt,
  TOKEN_TTL_DAYS,
} = require("./_customerReviewToken");
const { emitTimelineEvent } = require("./timelineEmit");
// PR 127a — when a review link is minted against an incident with an
// active recovery case, append the new PacketVersionRef + transition
// the case to awaiting_customer. Best-effort; never fails the mint.
const {
  RECOVERY_STATUS,
  TERMINAL_STATUSES,
} = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

async function writeAuditEntry(db, entry) {
  try {
    await db
      .collection("orgs")
      .doc(trimStr(entry.orgId))
      .collection("customer_review_audit")
      .add({ ...entry, createdAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error("[createCustomerReviewLinkV1] audit write failed", e && e.message);
  }
}

exports.createCustomerReviewLinkV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const incidentId = trimStr(body.incidentId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!incidentId) return j(res, 400, { ok: false, error: "incidentId required" });

    // Authz — admin/owner only.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createCustomerReviewLinkV1] authz_denied", {
        fn: "createCustomerReviewLinkV1",
        orgId, incidentId,
        uid: actorUid,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[createCustomerReviewLinkV1] authz_ok", {
      orgId, incidentId, uid: actorUid, role: actorRole,
    });

    const db = getFirestore();
    const { ref: incRef, exists } = await resolveIncidentRef(orgId, incidentId);
    if (!exists) {
      return j(res, 404, { ok: false, error: "incident_not_found", orgId, incidentId });
    }
    const incSnap = await incRef.get();
    const incData = incSnap.data() || {};
    const currentStatus = normalizeIncidentStatus(incData.status);

    // PR 126c — Two legitimate source states:
    //   in_progress: modern flow (PR 126a). Coordinator sends a record
    //                that's been internally approved but hasn't hit
    //                closeIncidentV1 yet.
    //   closed:      legacy flow. Record was sealed under the pre-126
    //                terminal model; coordinator routes it through
    //                customer review retroactively. Captured on the
    //                link doc + audit row as sourceStatus="closed" so
    //                reporting can distinguish.
    // Any other state (open, draft, submitted_to_customer,
    // customer_accepted, customer_rejected) is rejected — those are
    // either not-yet-ready or already mid-flow.
    if (currentStatus !== INCIDENT_STATUS.IN_PROGRESS && currentStatus !== INCIDENT_STATUS.CLOSED) {
      return j(res, 409, {
        ok: false,
        error: "invalid_status_for_review_link",
        detail: `requires status=in_progress or closed, got status=${currentStatus}`,
        currentStatus,
      });
    }
    if (!canTransitionIncident(currentStatus, INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER)) {
      return j(res, 409, {
        ok: false,
        error: "invalid_transition",
        detail: `${currentStatus} -> submitted_to_customer not allowed`,
      });
    }
    // Capture the source state for audit + reporting. Pinned at link-mint
    // time so subsequent transitions don't obscure the origin.
    const sourceStatus = currentStatus;

    // All-jobs-approved gate — mirrors closeIncidentV1.js (line 181).
    // Jobs live at the legacy path because createJobV1 hardcodes it.
    const legacyIncRef = db.collection("incidents").doc(incidentId);
    const jobsSnap = await legacyIncRef.collection("jobs").limit(500).get();
    if (jobsSnap.empty) {
      return j(res, 409, {
        ok: false,
        error: "no_jobs",
        detail: "incident has no jobs to send for review",
      });
    }
    const blocked = jobsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((job) => {
        const rs = String(job.reviewStatus || "").trim().toLowerCase();
        const st = String(job.status || "").trim().toLowerCase();
        return !(rs === "approved" || st === "approved");
      })
      .slice(0, 20)
      .map((job) => ({
        jobId: String(job.id || ""),
        title: String(job.title || ""),
        status: String(job.status || ""),
        reviewStatus: String(job.reviewStatus || ""),
      }));
    if (blocked.length) {
      return j(res, 409, {
        ok: false,
        error: "review_link_blocked_jobs_not_approved",
        reasons: blocked,
        hint: "All jobs must be approved before sending to customer.",
      });
    }

    // PEAKOPS_ENFORCEMENT_V1 (PR 133C) — block-mode gate. Reads org's
    // validation mode + computes DIRS compliance against incident +
    // evidence. When mode === "block" AND blocking conditions exist
    // (DIRS ERROR-severity findings or acceptance requirements missing),
    // refuses the link mint. Admin/owner override via
    // acknowledgeViolations + violationAcknowledgmentReason.
    // Override is recorded in audit + Cloud Logging + incident
    // timeline (INTERNAL — never surfaced to the customer or in the
    // review-link payload). The customer-facing /review/<token> page
    // is unaware that an override happened in this PR.
    {
      const _evidenceSnap = await legacyIncRef.collection("evidence_locker").limit(500).get().catch(() => ({ docs: [] }));
      const _evidenceTypes = _evidenceTypesFromList(_evidenceSnap.docs || []);
      const _incidentForEnforcement = { id: incidentId, ...(incData || {}) };
      const _acceptanceState = (incData && incData.readinessCache && incData.readinessCache.state) || null;
      const _enforcement = await evaluateEnforcement({
        db, orgId,
        incident: _incidentForEnforcement,
        evidenceTypes: _evidenceTypes,
        acceptanceReadinessState: _acceptanceState,
      });
      if (_enforcement.action === "block") {
        const _ack = parseOverride(body, actorRole);
        if (!_ack.ok) {
          await recordBlockTriggered({
            db, orgId, incidentId, callable: "createCustomerReviewLinkV1",
            evaluation: _enforcement, actorUid, actorRole,
          });
          return j(res, _ack.status || 412, {
            ok: false,
            error: "compliance_block",
            mode: _enforcement.mode,
            codes: _enforcement.codes,
            overridable: _enforcement.overridable,
            rulepackVersionsByType: _enforcement.rulepackVersionsByType,
            overrideHint: _ack.detail || "Admin/owner may bypass with acknowledgeViolations=true and violationAcknowledgmentReason (20-500 chars).",
            ackError: _ack.error,
          });
        }
        await recordBlockOverridden({
          db, orgId, incidentId, callable: "createCustomerReviewLinkV1",
          evaluation: _enforcement, actorUid, actorRole, reason: _ack.reason,
        });
      }
    }

    // PEAKOPS_REVIEW_VERSION_PIN_V1 (2026-06-15)
    // Require a packet exists for this incident before sending it to
    // a customer for review. The link captures the exact packet
    // snapshot (version, hashes, storage path) at mint time so a
    // future acceptance can be tied to specific bytes, not just a
    // moment in time. The pinned fields are write-once: this slice
    // adds them at mint; later slices read them in the customer
    // dossier + record them on the consume transaction.
    const pm = (incData.packetMeta && typeof incData.packetMeta === "object")
      ? incData.packetMeta : null;
    if (!pm
        || !Number.isFinite(Number(pm.packetVersion))
        || !trimStr(pm.storagePath)) {
      console.warn("[createCustomerReviewLinkV1] no_packet_yet", {
        orgId, incidentId, uid: actorUid,
        hasPacketMeta: !!pm,
        packetVersion: pm && pm.packetVersion,
      });
      return j(res, 409, {
        ok: false,
        error: "no_packet_yet",
        detail: "Generate a packet before sending this incident to a customer for review.",
      });
    }
    const _storagePathFull = trimStr(pm.storagePath);
    const pinnedPacket = {
      version: Number(pm.packetVersion),
      fileName: _storagePathFull
        ? (_storagePathFull.split("/").pop() || "")
        : "",
      storagePath: _storagePathFull,
      bucket: trimStr(pm.bucket),
      zipSha256: trimStr(pm.zipSha256),
      originalRecordHash: trimStr(pm.originalRecordHash),
      generatedAt: trimStr(pm.exportedAt),
      pinnedAt: FieldValue.serverTimestamp(),
    };

    // Mint the token. Cleartext returned once below; only the hash
    // is persisted.
    const token = generateToken();
    const tokenHash = hashToken(token);
    const tokenHashPrefix = hashPrefix(token);

    // Snapshot the template provenance at link-creation time so the
    // audit row preserves which template version the customer was
    // shown, even if the operator edits the template later.
    const requirements = (incData.requirements && typeof incData.requirements === "object") ? incData.requirements : {};
    const templateKey = trimStr(requirements.templateKey);
    const templateVersion = Number.isFinite(Number(requirements.templateVersion))
      ? Number(requirements.templateVersion)
      : null;
    const customerLabel = trimStr(requirements.customerLabel) || trimStr(incData.customer);
    const archetype = trimStr(requirements.archetype) || trimStr(incData.archetype);

    // Link docs live at the top-level `customer_review_links/{tokenHash}`
    // so token lookup in getCustomerReviewV1 / submitCustomerReviewV1
    // is O(1) without orgId in the URL. Multi-tenancy is preserved by
    // the `orgId` field on the doc; Cloud Functions enforce all access.
    // The audit collection (`orgs/{orgId}/customer_review_audit`) stays
    // org-nested because audit reads are operator-facing.
    const linkRef = db.doc(`customer_review_links/${tokenHash}`);
    // PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 (Chunk 1, 2026-06-22)
    // Compute expiresAt at mint time using a deterministic 90-day
    // window (TOKEN_TTL_DAYS). createdAt is a serverTimestamp
    // sentinel and unreadable client-side, so we compute the
    // expiration from the function's clock (which is in turn
    // verified by Firestore's clock on persistence). Drift between
    // function-clock and Firestore-clock is bounded and inconsequential
    // for a 90-day TTL.
    const _expiresAt = computeExpiresAt();
    const linkPayload = {
      incidentId,
      orgId,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actorUid,
      // PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 — populated.
      // Format: Firestore Timestamp (Date converted on write).
      // Backstop only; operators can revoke earlier via revokedAt.
      expiresAt: _expiresAt,
      expiresInDays: TOKEN_TTL_DAYS,
      revokedAt: null,
      revokedBy: null,
      firstAccessedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
      consumedAt: null,
      consumedAction: null,
      // Sliding-window rate-limit timestamps (epoch ms).
      recentGetTimestamps: [],
      recentPostTimestamps: [],
      // Denorms for the (future) revocation listing UI.
      customerLabel,
      archetype,
      templateKey,
      templateVersion,
      // PR 126c — incident status at link-mint time. Always
      // "in_progress" or "closed". Disambiguates legitimate workflow
      // origins in reporting and audit queries.
      sourceStatus,
      // PEAKOPS_REVIEW_VERSION_PIN_V1 (2026-06-15)
      // Immutable snapshot of the packet that was current at mint
      // time. Subsequent slices (UI + accept) read these to display
      // version drift + record which bytes the customer accepted.
      pinnedPacket,
    };
    await linkRef.set(linkPayload);

    // Transition incident.status -> submitted_to_customer.
    await incRef.set(
      {
        status: INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER,
        submittedToCustomerAt: FieldValue.serverTimestamp(),
        submittedToCustomerBy: actorUid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Timeline event — incident-level audit.
    await emitTimelineEvent({
      orgId,
      incidentId,
      type: "customer_review_link_created",
      actor: "coordinator_ui",
      actorUid,
      meta: {
        tokenHashPrefix,
        templateKey,
        templateVersion,
        customerLabel,
        // PR 126c — origin tag preserved across the audit chain.
        sourceStatus,
      },
    });

    // Cross-incident audit row.
    await writeAuditEntry(db, {
      type: "customer_review_link_created",
      orgId,
      incidentId,
      templateKey,
      templateVersion,
      actorKind: "coordinator",
      actorUid,
      tokenHashPrefix,
      customerLabel,
      // PR 126c — distinguishes "in_progress" path from legacy "closed".
      sourceStatus,
    });

    // PEAKOPS_REVIEW_LINK_NOTIFY_V1 (Chunk 2: Workflow Completion, 2026-06-22)
    // Fan out an in-app notification so other supervisors see that a
    // review link is now outstanding. Without this, two operators could
    // mint two links in parallel (the second silently overrides the
    // first's effect on incident status). Notification is visible via
    // the NotificationsBell. Best-effort: errors logged + swallowed —
    // a notify failure must NEVER block the mint, which has already
    // landed.
    try {
      let _notify = null;
      try { _notify = require("./_notify"); } catch (_) { /* optional */ }
      if (_notify && typeof _notify.fanOutOrgNotification === "function") {
        const _displayCustomer = customerLabel || "the customer";
        const result = await _notify.fanOutOrgNotification({
          orgId,
          recipientRoles: ["admin", "supervisor"],
          additionalUids: actorUid ? [actorUid] : [],
          payload: {
            type: "customer_review_link_created",
            title: "Review link sent",
            message: `Review link for ${_displayCustomer} is awaiting customer response.`,
            incidentId,
            orgId,
            targetUrl: `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}`,
          },
        });
        const wrote = typeof result === "number" ? result : (result?.wrote || 0);
        const recipients = typeof result === "number" ? result : (result?.recipients || result?.wrote || 0);
        console.log(`[notify] customer_review_link_created recipients=${recipients} wrote=${wrote}`);
      }
    } catch (e) {
      console.warn("[createCustomerReviewLinkV1] notify failed", e && e.message);
    }

    // PR 127a — If an active recovery case exists for this incident,
    // append the new PacketVersionRef and transition the case to
    // awaiting_customer. Best-effort; mint always succeeds even if
    // this fails.
    let linkedRecoveryCaseId = null;
    try {
      const casesQuery = await db
        .collection("orgs").doc(orgId).collection("recovery_cases")
        .where("incidentId", "==", incidentId)
        .where("status", "in", [
          RECOVERY_STATUS.OPEN,
          RECOVERY_STATUS.IN_PROGRESS,
          RECOVERY_STATUS.READY_TO_RESUBMIT,
          RECOVERY_STATUS.AWAITING_CUSTOMER,
          RECOVERY_STATUS.ESCALATED,
          // PR 129a — legacy tolerance: pre-129a triaged cases.
          "triaged",
        ])
        .limit(1)
        .get();
      if (!casesQuery.empty) {
        const caseRef = casesQuery.docs[0].ref;
        const caseData = casesQuery.docs[0].data() || {};
        if (!TERMINAL_STATUSES.has(String(caseData.status || ""))) {
          const prevPkts = Array.isArray(caseData.packetVersions) ? caseData.packetVersions.slice() : [];
          // PR 129a — ordinal = next position in the immutable chain.
          // Persisted so the UI can render "v3 of N" without recomputing.
          const ordinal = prevPkts.length + 1;
          const packetVersionRef = {
            packetVersionId: tokenHashPrefix,
            ordinal,
            outcome: "pending",
            outcomeAt: null,
            mintedAt: new Date().toISOString(),
            mintedBy: actorUid,
            templateVersionAtMint: templateVersion,
          };
          const dup = prevPkts.some((p) => p && p.packetVersionId === tokenHashPrefix);
          const newPkts = dup ? prevPkts : prevPkts.concat([packetVersionRef]);
          await caseRef.update({
            packetVersions: newPkts,
            currentPacketVersion: tokenHashPrefix,
            // PR 129a — cycleCount dropped; resubmissionCount derived
            // at read time from packetVersions.length - 1.
            status: RECOVERY_STATUS.AWAITING_CUSTOMER,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: actorUid,
          });
          linkedRecoveryCaseId = caseRef.id;
          await writeRecoveryAudit({
            type: "packet_version_appended",
            orgId, caseId: caseRef.id, incidentId,
            actorUid,
            meta: { tokenHashPrefix, ordinal, sourceStatus, templateVersion },
          });
          if (caseData.status !== RECOVERY_STATUS.AWAITING_CUSTOMER) {
            await writeRecoveryAudit({
              type: "case_status_changed",
              orgId, caseId: caseRef.id, incidentId,
              actorUid,
              before: { status: caseData.status },
              after: { status: RECOVERY_STATUS.AWAITING_CUSTOMER },
              meta: { reason: "review_link_minted" },
            });
          }
        }
      }
    } catch (e) {
      console.error("[createCustomerReviewLinkV1] recovery_link failed", e && e.message);
    }

    console.log("[createCustomerReviewLinkV1] link_created", {
      orgId, incidentId, tokenHashPrefix, templateVersion, actorUid, sourceStatus,
      linkedRecoveryCaseId,
    });

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      token,                                 // cleartext — RETURNED ONCE
      tokenHashPrefix,
      url: `/review/${token}`,
      status: INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER,
      templateKey,
      templateVersion,
      customerLabel,
      // PR 126c — clients can branch UI on whether this was a fresh
      // (in_progress) flow or a retroactive (closed) one.
      sourceStatus,
      // PR 127a — if an active recovery case was linked to this mint,
      // return its id so the operator UI can show "Mint linked to
      // case <id>" instead of just the URL.
      linkedRecoveryCaseId,
    });
  } catch (e) {
    console.error("[createCustomerReviewLinkV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
