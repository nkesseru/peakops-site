// PEAKOPS_RECOVERY_CASE_V1 (PR 127a)
//
// Admin / coordinator-only callable that manually opens a Recovery Case
// for an existing incident. The auto-create path (driven inline from
// submitCustomerReviewV1) covers customer_rejected events; this
// callable handles operator-initiated cases — typically:
//
//   - Internal QC catches a problem before customer review
//   - Aging unaccepted record that needs structured tracking
//   - Manager-flagged record at risk
//
// Differences from auto-create:
//   - Firestore auto-id (vs deterministic for auto-create)
//   - Operator supplies cause, priority, revenueAtRisk upfront
//   - No starter action (operator creates them via addRecoveryActionV1)
//
// Input (POST):
//   {
//     orgId, incidentId, actorUid?,
//     source: "customer_rejected" | "internal_qc",
//     priority?: "low" | "medium" | "high" | "critical",
//     cause?: {
//       primary?, secondary?, customerComment?, operatorNotes?,
//     },
//     revenueAtRisk?: { amount, type, currency?, notes? },
//     ownerUid?, ownerRole?,
//   }

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
  RECOVERY_STATUS,
  RECOVERY_PRIORITY_SET,
  RECOVERY_SOURCE_SET,
  REVENUE_TYPE_SET,
  RECOVERY_CAUSE_PRIMARY_SET,
  OWNER_ROLES_SET,
} = require("./recoveryState");
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

exports.createRecoveryCaseV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = trimStr(body.orgId);
    const incidentId = trimStr(body.incidentId);
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!incidentId) return j(res, 400, { ok: false, error: "incidentId required" });

    // Authz — admin/owner only (coordinators are the typical caller but
    // for MVP we gate on the same role set used elsewhere).
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createRecoveryCaseV1] authz_denied", {
        fn: "createRecoveryCaseV1", orgId, incidentId, uid: actorUid, code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    // Validate enum fields.
    const source = trimStr(body.source).toLowerCase();
    if (!RECOVERY_SOURCE_SET.has(source)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_source",
        detail: "source must be 'customer_rejected' or 'internal_qc'",
      });
    }

    const priority = trimStr(body.priority || "").toLowerCase() || "medium";
    if (!RECOVERY_PRIORITY_SET.has(priority)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_priority",
        detail: "priority must be one of: low, medium, high, critical",
      });
    }

    // Cause is optional on create — operator may want to triage later.
    let cause = {};
    if (body.cause && typeof body.cause === "object") {
      const primary = trimStr(body.cause.primary || "").toLowerCase();
      if (primary && !RECOVERY_CAUSE_PRIMARY_SET.has(primary)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_cause_primary",
          detail: `cause.primary must be one of the 10 known causes`,
        });
      }
      cause = {
        ...(primary ? { primary } : {}),
        ...(body.cause.secondary ? { secondary: sanitizeText(body.cause.secondary, SECONDARY_MAX) } : {}),
        ...(body.cause.customerComment ? { customerComment: sanitizeText(body.cause.customerComment, COMMENT_MAX) } : {}),
        ...(body.cause.operatorNotes ? { operatorNotes: sanitizeText(body.cause.operatorNotes, NOTES_MAX) } : {}),
        ...(primary ? { categorizedBy: actorUid, categorizedAt: FieldValue.serverTimestamp() } : {}),
      };
    }

    // Revenue at risk — optional on create; defaults to unknown/0.
    let revenueAtRisk = {
      amount: 0,
      currency: "USD",
      type: "unknown",
      enteredBy: actorUid,
      enteredAt: FieldValue.serverTimestamp(),
    };
    if (body.revenueAtRisk && typeof body.revenueAtRisk === "object") {
      const rawAmount = Number(body.revenueAtRisk.amount);
      if (!Number.isFinite(rawAmount) || rawAmount < 0) {
        return j(res, 400, {
          ok: false,
          error: "invalid_revenue_amount",
          detail: "revenueAtRisk.amount must be a non-negative number",
        });
      }
      const type = trimStr(body.revenueAtRisk.type || "unknown").toLowerCase();
      if (!REVENUE_TYPE_SET.has(type)) {
        return j(res, 400, {
          ok: false,
          error: "invalid_revenue_type",
          detail: "revenueAtRisk.type must be 'actual', 'estimated', or 'unknown'",
        });
      }
      revenueAtRisk = {
        amount: rawAmount,
        currency: "USD",
        type,
        enteredBy: actorUid,
        enteredAt: FieldValue.serverTimestamp(),
        ...(body.revenueAtRisk.notes ? { notes: sanitizeText(body.revenueAtRisk.notes, NOTES_MAX) } : {}),
      };
    }

    // Ownership — defaults to actor if not specified.
    const ownerUid = trimStr(body.ownerUid) || actorUid;
    const ownerRole = trimStr(body.ownerRole || "coordinator").toLowerCase();
    if (!OWNER_ROLES_SET.has(ownerRole)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_owner_role",
        detail: "ownerRole must be one of: coordinator, supervisor, field_lead, manager",
      });
    }

    // Verify the incident exists at canonical or legacy path.
    const { exists: incExists } = await resolveIncidentRef(orgId, incidentId);
    if (!incExists) {
      return j(res, 404, { ok: false, error: "incident_not_found", orgId, incidentId });
    }

    // Pull template provenance from incident (best-effort).
    const db = getFirestore();
    const incRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    const incSnap = await incRef.get().catch(() => null);
    const incData = incSnap && incSnap.exists ? (incSnap.data() || {}) : {};
    const reqSnapshot = (incData.requirements && typeof incData.requirements === "object") ? incData.requirements : {};
    const templateKey = trimStr(reqSnapshot.templateKey || "");
    const templateVersion = Number.isFinite(Number(reqSnapshot.templateVersion))
      ? Number(reqSnapshot.templateVersion)
      : null;

    // Create case with Firestore auto-id (per PR 127a decision #1).
    const caseRef = db.collection("orgs").doc(orgId).collection("recovery_cases").doc();
    const now = FieldValue.serverTimestamp();
    const newCase = {
      id: caseRef.id,
      orgId,
      incidentId,
      ...(templateKey ? { templateKey } : {}),
      ...(templateVersion != null ? { templateVersion } : {}),
      status: RECOVERY_STATUS.OPEN,
      priority,
      revenueAtRisk,
      cause,
      rejection: {
        source,
        tokenHashPrefix: null,
        rejectedAt: now,
        rejectedBy: source === "customer_rejected" ? "customer" : actorUid,
      },
      ownership: {
        owner: ownerUid,
        ownerRole,
        assignedAt: now,
        assignedBy: actorUid,
        history: [],
      },
      packetVersions: [],
      currentPacketVersion: null,
      cycleCount: 0,
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
    await caseRef.set(newCase);

    // Audit.
    await writeRecoveryAudit({
      type: "case_opened",
      orgId, caseId: caseRef.id, incidentId,
      actorUid, actorRole,
      meta: { source, priority, manual: true },
    });

    console.log("[createRecoveryCaseV1] case_opened", {
      orgId, incidentId, caseId: caseRef.id, source, priority, actorUid,
    });

    return j(res, 200, {
      ok: true,
      orgId, incidentId,
      caseId: caseRef.id,
      status: RECOVERY_STATUS.OPEN,
      priority,
      source,
    });
  } catch (e) {
    console.error("[createRecoveryCaseV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
