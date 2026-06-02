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
const {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
} = require("./incidentState");
const {
  generateToken,
  hashToken,
  hashPrefix,
} = require("./_customerReviewToken");
const { emitTimelineEvent } = require("./timelineEmit");

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
    const linkPayload = {
      incidentId,
      orgId,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actorUid,
      // Phase 0 — no TTL; Phase 1 will populate this.
      expiresAt: null,
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

    console.log("[createCustomerReviewLinkV1] link_created", {
      orgId, incidentId, tokenHashPrefix, templateVersion, actorUid, sourceStatus,
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
    });
  } catch (e) {
    console.error("[createCustomerReviewLinkV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
