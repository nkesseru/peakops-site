// PEAKOPS_RECOVERY_ACTION_V1 (PR 127a)
//
// Admin/owner-only callable to add a Recovery Action to an existing
// Recovery Case. Mirrors the schema authored in recoveryState.js.
//
// Evidence validation (per PR 127a decision #4): if body.evidence is
// supplied, every evidenceId must exist in the linked incident's
// evidence_locker (canonical OR legacy subcollection). Returns
// 400 invalid_evidence with the failing ids if any don't resolve.
//
// Auto-id: actions get Firestore auto-id unless an explicit id is
// supplied (used only by the starter-action auto-create path, which
// lives in _recoveryAutoCreate.js).

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
  RECOVERY_ACTION_TYPES_SET,
  OWNER_ROLES_SET,
} = require("./recoveryState");
const { writeRecoveryAudit } = require("./_recoveryAudit");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;

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

// PR 127a #4 — Validate each supplied evidenceId exists in the
// incident's evidence_locker at either canonical or legacy path.
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
    if ((cSnap && cSnap.exists) || (lSnap && lSnap.exists)) {
      valid.push(cleanId);
    } else {
      invalid.push(cleanId);
    }
  }
  return { valid, invalid };
}

exports.addRecoveryActionV1 = onRequest({ cors: true }, async (req, res) => {
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

    // Validate action type.
    const type = trimStr(body.type).toLowerCase();
    if (!RECOVERY_ACTION_TYPES_SET.has(type)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_action_type",
        detail: `type must be one of: ${Array.from(RECOVERY_ACTION_TYPES_SET).join(", ")}`,
      });
    }

    // Title required.
    const title = sanitizeText(body.title, TITLE_MAX);
    if (!title) {
      return j(res, 400, { ok: false, error: "title_required", detail: "title is required and must be non-empty" });
    }
    const description = sanitizeText(body.description, DESCRIPTION_MAX);

    // Validate assignee role if supplied.
    const assignee = trimStr(body.assignee) || "";
    const assigneeRole = trimStr(body.assigneeRole || "").toLowerCase() || "";
    if (assigneeRole && !OWNER_ROLES_SET.has(assigneeRole)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_assignee_role",
        detail: "assigneeRole must be one of: coordinator, supervisor, field_lead, manager",
      });
    }

    // Verify case exists.
    const db = getFirestore();
    const caseRef = db.collection("orgs").doc(orgId).collection("recovery_cases").doc(caseId);
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) {
      return j(res, 404, { ok: false, error: "case_not_found", caseId });
    }
    const caseData = caseSnap.data() || {};
    const incidentId = trimStr(caseData.incidentId);

    // Validate evidence ids if supplied.
    let evidenceEntries = [];
    if (Array.isArray(body.evidence) && body.evidence.length > 0) {
      const ids = body.evidence.map((e) => (e && e.evidenceId) || e).filter(Boolean);
      const { valid, invalid } = await validateEvidenceIds(db, orgId, incidentId, ids);
      if (invalid.length > 0) {
        return j(res, 400, {
          ok: false,
          error: "invalid_evidence",
          detail: `Some evidence ids don't exist on the linked incident's evidence_locker`,
          invalidIds: invalid,
        });
      }
      evidenceEntries = valid.map((id) => ({
        evidenceId: id,
        addedBy: actorUid,
        addedAt: new Date().toISOString(),
      }));
    }

    // Create action with Firestore auto-id.
    const actionRef = caseRef.collection("actions").doc();
    const now = FieldValue.serverTimestamp();
    const newAction = {
      id: actionRef.id,
      caseId,
      orgId,
      type,
      title,
      ...(description ? { description } : {}),
      status: "open",
      ...(assignee ? { assignee } : {}),
      ...(assigneeRole ? { assigneeRole } : {}),
      dueAt: null,
      startedAt: null,
      completedAt: null,
      evidence: evidenceEntries,
      outcome: null,
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
    };
    await actionRef.set(newAction);

    // Touch case updatedAt so list views reflect activity.
    await caseRef.update({
      updatedAt: now,
      updatedBy: actorUid,
    });

    await writeRecoveryAudit({
      type: "action_created",
      orgId, caseId,
      incidentId,
      actionId: actionRef.id,
      actorUid, actorRole,
      meta: { type, evidenceCount: evidenceEntries.length },
    });
    if (assignee) {
      await writeRecoveryAudit({
        type: "action_assigned",
        orgId, caseId, incidentId,
        actionId: actionRef.id,
        actorUid, actorRole,
        meta: { assignee, assigneeRole: assigneeRole || null },
      });
    }

    return j(res, 200, {
      ok: true,
      orgId, caseId,
      actionId: actionRef.id,
      type,
      status: "open",
    });
  } catch (e) {
    console.error("[addRecoveryActionV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
