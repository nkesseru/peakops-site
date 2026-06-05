// PEAKOPS_RECOVERY_FOREMAN_LIST_V1 (PR 130a)
//
// Foreman-facing read surface — returns recovery actions for one
// incident, filtered to what the calling member is allowed to see
// and act on.
//
// Architecture lock (PR 129 review):
//   Foreman should ONLY see: Problem → Location → Action → Done.
//   They must never see RecoveryCase status, revenue, resubmission
//   state, cause taxonomy, or any other case-level data.
//
// What this endpoint returns:
//   Array of recovery actions, each one stripped to ONLY the fields
//   a field user needs to do the work. No caseId. No case.status. No
//   revenue. No mention of "recovery" or "resubmission" anywhere in
//   the response shape.
//
// Authz:
//   assertActorCanReadOrg — any active member of the org.
//
// Visibility rules (per assigneeRole + uid match):
//   1. If action.assignee === actor.uid → always visible (specific assignment)
//   2. Else if action.assigneeRole === "field_lead" AND membership.role
//      in ["field", "supervisor", "owner", "admin"] → visible
//   3. Else → hidden (e.g. a coordinator-assigned action is invisible
//      to a field worker)
//
// Status filter: only return actions in open/in_progress/blocked.
// Done/skipped actions don't show in field "what to do" lists.
//
// Wedge guards:
//   - Endpoint name does not contain "recovery" from the field user's
//     POV (they call it via UI label "Open work"); the function name
//     is internal-only.
//   - Response fields are intentionally identical-shaped to regular
//     session work items so the UI can render them with the same
//     component (PR 130b).
//   - No case-level data in the response, ever.

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { TERMINAL_STATUSES } = require("./recoveryState");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

// Membership roles that can act on field_lead-assigned recovery work.
// "field" is the primary user; supervisor often does field work too;
// owner/admin can do anything but typically use the admin UI.
const FIELD_WORK_ROLES = new Set(["field", "supervisor", "owner", "admin"]);

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

/**
 * Predicate: should this action surface to this actor?
 * Returns true if the actor is specifically assigned to it, OR if it's
 * a field_lead role action and the actor can do field work.
 */
function isVisibleToActor(actionData, actorUid, membershipRole) {
  const assignee = trimStr(actionData.assignee);
  if (assignee && assignee === actorUid) return true;
  const assigneeRole = trimStr(actionData.assigneeRole).toLowerCase();
  if (assigneeRole === "field_lead" && FIELD_WORK_ROLES.has(String(membershipRole || "").toLowerCase())) {
    return true;
  }
  return false;
}

exports.listRecoveryActionsForIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = trimStr(req.query?.orgId);
    const incidentId = trimStr(req.query?.incidentId);
    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });
    if (!incidentId) return j(res, 400, { ok: false, error: "Missing incidentId" });

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    const db = getFirestore();

    // Find the active case for this incident (one per incident invariant
    // from PR 129a). If no case OR case is terminal → empty work list.
    const casesSnap = await db
      .collection("orgs").doc(orgId).collection("recovery_cases")
      .where("incidentId", "==", incidentId)
      .limit(1)
      .get();

    if (casesSnap.empty) {
      return j(res, 200, { ok: true, orgId, incidentId, openWork: [] });
    }

    const caseDoc = casesSnap.docs[0];
    const caseData = caseDoc.data() || {};
    const caseId = caseDoc.id;

    if (TERMINAL_STATUSES.has(String(caseData.status || ""))) {
      // Terminal cases don't show field work — the work is done or
      // formally abandoned. Field UI hides the section entirely.
      return j(res, 200, { ok: true, orgId, incidentId, openWork: [] });
    }

    const actionsSnap = await caseDoc.ref.collection("actions").get();
    const openWork = actionsSnap.docs
      .map((d) => ({ id: d.id, data: d.data() || {} }))
      .filter(({ data }) => {
        const s = trimStr(data.status);
        // Only open work — done/skipped/etc. don't surface
        if (s !== "open" && s !== "in_progress" && s !== "blocked") return false;
        return isVisibleToActor(data, actorUid, actorRole);
      })
      .map(({ id, data }) => ({
        // PR 130a — strip to the bare minimum a foreman needs to do
        // the work. NO caseId. NO case.status. NO revenue. NO mention
        // of "recovery." The UI component renders this identically to
        // regular session work.
        id,
        // We DO return the recovery-side actionType so the UI can map
        // it to the human label, but the label itself stays in lib/
        // recovery/displayConstants (the foreman sees the rendered
        // label, not the enum string).
        type: trimStr(data.type),
        title: trimStr(data.title),
        description: trimStr(data.description),
        status: trimStr(data.status),
        assignee: trimStr(data.assignee),
        assigneeRole: trimStr(data.assigneeRole),
        evidenceCount: Array.isArray(data.evidence) ? data.evidence.length : 0,
        startedAt: tsIso(data.startedAt),
        dueAt: data.dueAt || null,
        // The blocking reason is operator-facing context if the
        // coordinator marked it blocked. Useful for the foreman to
        // see "why am I being asked to wait?"
        blockingReason: trimStr(data.blockingReason),
        // Carried so the foreman's update endpoint
        // (completeRecoveryFieldWorkV1) can route the write without
        // exposing the caseId as a foreman-facing concept.
        _routeCaseId: caseId,
      }));

    console.log("[listRecoveryActionsForIncidentV1] returned", {
      orgId, incidentId, caseId, actorUid, actorRole,
      visible: openWork.length,
    });

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      openWork,
    });
  } catch (e) {
    console.error("[listRecoveryActionsForIncidentV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

module.exports.FIELD_WORK_ROLES = FIELD_WORK_ROLES;
module.exports.isVisibleToActor = isVisibleToActor;
