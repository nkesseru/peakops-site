// PEAKOPS_RECOVERY_GET_V1 (PR 127a2)
//
// Admin/coordinator-only callable that returns full Recovery Case
// detail for the operator-side detail view. Per PR 127a2 planning:
//   - Returns the case doc with derived priority (read-time computation)
//   - Returns ALL actions on the case (typically <10; no paging)
//   - Returns the last 50 audit rows, newest first
//   - 404 when the case doesn't exist
//
// This is the single read endpoint the operator UI's case-detail page
// uses to hydrate everything. One round-trip instead of three.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { derivePriority, daysOpenSince } = require("./_recoveryPriority");

if (!admin.apps.length) admin.initializeApp();

const AUDIT_LIMIT = 50;

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

exports.getRecoveryCaseV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = trimStr(req.query?.orgId);
    const caseId = trimStr(req.query?.caseId);
    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });
    if (!caseId) return j(res, 400, { ok: false, error: "Missing caseId" });

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    const db = getFirestore();
    const caseRef = db.collection("orgs").doc(orgId).collection("recovery_cases").doc(caseId);

    // Parallel reads — case doc, actions subcollection, audit query.
    const [caseSnap, actionsSnap, auditSnap] = await Promise.all([
      caseRef.get(),
      caseRef.collection("actions").get(),
      db.collection("orgs").doc(orgId).collection("recovery_audit")
        .where("caseId", "==", caseId)
        .orderBy("createdAt", "desc")
        .limit(AUDIT_LIMIT)
        .get()
        .catch((e) => {
          // If the composite index is missing in this env, fall back
          // to unsorted + JS sort. Production will have the index
          // (firestore.indexes.json updated in this PR).
          console.warn("[getRecoveryCaseV1] audit index fallback", e && e.message);
          return null;
        }),
    ]);

    if (!caseSnap.exists) {
      return j(res, 404, { ok: false, error: "case_not_found", caseId });
    }

    const data = caseSnap.data() || {};

    // PR 127c-a — denorm incident.title + incident.location into the
    // response so the operator UI's "WHERE" and job-name surfaces have
    // the data without a second round-trip. Reads the incident doc
    // canonically; on failure (incident deleted out from under the case)
    // the fields just return empty strings — UI flags as data defect.
    let jobTitle = "";
    let jobLocation = "";
    try {
      const incidentId = trimStr(data.incidentId);
      if (incidentId) {
        const canonicalIncRef = db.collection("orgs").doc(orgId)
          .collection("incidents").doc(incidentId);
        let incSnap = await canonicalIncRef.get();
        if (!incSnap.exists) {
          incSnap = await db.collection("incidents").doc(incidentId).get();
        }
        if (incSnap.exists) {
          const incData = incSnap.data() || {};
          jobTitle = trimStr(incData.title || incData.name);
          jobLocation = trimStr(incData.location || incData.address || incData.siteAddress);
        }
      }
    } catch (e) {
      console.warn("[getRecoveryCaseV1] incident denorm failed", e && e.message);
    }

    // ── Derive priority from current amount + aging ────────────
    const amount = Number(data.revenueAtRisk?.amount);
    const amountType = trimStr(data.revenueAtRisk?.type) || "unknown";
    const daysOpen = daysOpenSince(data.openedAt);
    const derivedPriority = derivePriority({ amount, daysOpen, amountType });

    // ── Actions — return ALL (per planning #5) ─────────────────
    const actions = actionsSnap.docs
      .map((d) => {
        const a = d.data() || {};
        return {
          id: d.id,
          caseId,
          type: trimStr(a.type),
          title: trimStr(a.title),
          description: trimStr(a.description),
          status: trimStr(a.status),
          assignee: trimStr(a.assignee),
          assigneeRole: trimStr(a.assigneeRole),
          evidence: Array.isArray(a.evidence) ? a.evidence : [],
          outcome: trimStr(a.outcome),
          blockingReason: trimStr(a.blockingReason),
          dueAt: a.dueAt || null,
          startedAt: tsIso(a.startedAt),
          completedAt: tsIso(a.completedAt),
          createdAt: tsIso(a.createdAt),
          createdBy: trimStr(a.createdBy),
        };
      })
      .sort((a, b) => {
        // open/in_progress/blocked first; done/skipped last; stable by createdAt
        const order = { open: 0, in_progress: 1, blocked: 2, done: 3, skipped: 4 };
        const ao = order[a.status] ?? 5;
        const bo = order[b.status] ?? 5;
        if (ao !== bo) return ao - bo;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      });

    // ── Audit — last 50, newest first ──────────────────────────
    let audit = [];
    if (auditSnap && !auditSnap.empty) {
      audit = auditSnap.docs.map((d) => {
        const a = d.data() || {};
        return {
          id: d.id,
          type: trimStr(a.type),
          actorUid: trimStr(a.actorUid),
          actorRole: trimStr(a.actorRole),
          actionId: trimStr(a.actionId),
          before: a.before || null,
          after: a.after || null,
          meta: a.meta || null,
          createdAt: tsIso(a.createdAt),
        };
      });
    } else {
      // Fallback path: index missing — read without orderBy, sort in JS, take last 50.
      const fb = await db.collection("orgs").doc(orgId)
        .collection("recovery_audit")
        .where("caseId", "==", caseId)
        .get();
      const all = fb.docs.map((d) => ({ id: d.id, ...d.data() }));
      all.sort((a, b) => {
        const at = a.createdAt?._seconds || 0;
        const bt = b.createdAt?._seconds || 0;
        return bt - at;
      });
      audit = all.slice(0, AUDIT_LIMIT).map((a) => ({
        id: a.id,
        type: trimStr(a.type),
        actorUid: trimStr(a.actorUid),
        actorRole: trimStr(a.actorRole),
        actionId: trimStr(a.actionId),
        before: a.before || null,
        after: a.after || null,
        meta: a.meta || null,
        createdAt: tsIso(a.createdAt),
      }));
    }

    // ── Build case object ──────────────────────────────────────
    const detail = {
      caseId,
      orgId,
      incidentId: trimStr(data.incidentId),
      // PR 127c-a — denormed from the incident doc for the UI hero
      // "WHERE" section and queue list rendering.
      jobTitle,
      jobLocation,
      templateKey: trimStr(data.templateKey),
      templateVersion: Number.isFinite(Number(data.templateVersion)) ? Number(data.templateVersion) : null,

      status: trimStr(data.status) || "open",
      // PR 127a2 — derived; persisted data.priority is informational only.
      priority: derivedPriority,

      revenueAtRisk: {
        amount: Number.isFinite(amount) ? amount : 0,
        currency: trimStr(data.revenueAtRisk?.currency) || "USD",
        type: amountType,
        notes: trimStr(data.revenueAtRisk?.notes),
        enteredBy: trimStr(data.revenueAtRisk?.enteredBy),
        enteredAt: tsIso(data.revenueAtRisk?.enteredAt),
      },

      cause: {
        primary: trimStr(data.cause?.primary),
        secondary: trimStr(data.cause?.secondary),
        customerComment: trimStr(data.cause?.customerComment),
        operatorNotes: trimStr(data.cause?.operatorNotes),
        categorizedBy: trimStr(data.cause?.categorizedBy),
        categorizedAt: tsIso(data.cause?.categorizedAt),
      },

      rejection: {
        source: trimStr(data.rejection?.source),
        tokenHashPrefix: trimStr(data.rejection?.tokenHashPrefix),
        rejectedAt: tsIso(data.rejection?.rejectedAt),
        rejectedBy: trimStr(data.rejection?.rejectedBy),
      },

      ownership: {
        owner: trimStr(data.ownership?.owner),
        ownerRole: trimStr(data.ownership?.ownerRole),
        assignedAt: tsIso(data.ownership?.assignedAt),
        assignedBy: trimStr(data.ownership?.assignedBy),
        history: Array.isArray(data.ownership?.history) ? data.ownership.history : [],
      },

      packetVersions: Array.isArray(data.packetVersions) ? data.packetVersions : [],
      currentPacketVersion: trimStr(data.currentPacketVersion),
      cycleCount: Number.isFinite(Number(data.cycleCount)) ? Number(data.cycleCount) : 0,

      openedAt: tsIso(data.openedAt),
      daysOpen,
      resolvedAt: tsIso(data.resolvedAt),

      resolution: data.resolution ? {
        outcome: trimStr(data.resolution.outcome),
        resolvedBy: trimStr(data.resolution.resolvedBy),
        resolvedAt: tsIso(data.resolution.resolvedAt),
        finalAmount: Number.isFinite(Number(data.resolution.finalAmount)) ? Number(data.resolution.finalAmount) : null,
        notes: trimStr(data.resolution.notes),
      } : null,

      createdAt: tsIso(data.createdAt),
      createdBy: trimStr(data.createdBy),
      updatedAt: tsIso(data.updatedAt),
      updatedBy: trimStr(data.updatedBy),
    };

    console.log("[getRecoveryCaseV1] returned", {
      orgId, caseId,
      actionCount: actions.length,
      auditCount: audit.length,
      derivedPriority,
      actorUid, actorRole,
    });

    return j(res, 200, {
      ok: true,
      orgId, caseId,
      case: detail,
      actions,
      audit,
    });
  } catch (e) {
    console.error("[getRecoveryCaseV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
