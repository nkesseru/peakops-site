const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();
const db = getFirestore();

// Timeline event emission delegated to the shared helper in
// functions_clean/timelineEmit.js which writes to the canonical
// top-level path `incidents/{incidentId}/timeline_events`. Prior
// to this fix this file had its own local emitTimelineEvent that
// hardcoded `orgs/{orgId}/incidents/{incidentId}/timeline_events`,
// causing dual-write drift between paths because every OTHER
// timeline emitter in the codebase (timelineEmit.js consumers:
// addEvidenceV1, startFieldSessionV1, assignJobOrgV1, etc.) goes
// to top-level. Notes saves now agree.


function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

// POST /saveIncidentNotesV1 { orgId, incidentId, incidentNotes, siteNotes, updatedBy }
exports.saveIncidentNotesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const b = (req.body && typeof req.body === "object") ? req.body : {};
    const orgId = mustStr(b.orgId, "orgId");
    const incidentId = mustStr(b.incidentId, "incidentId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: notes are field-or-above. Field crews routinely
    // append to incident notes from the field surface, so the gate
    // accepts admin/supervisor/field/owner. Viewer is denied.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, b));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[saveIncidentNotesV1] authz_denied", {
        fn: "saveIncidentNotesV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[saveIncidentNotesV1] authz_ok", {
      fn: "saveIncidentNotesV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const incidentNotes = String(b.incidentNotes || "");
    const siteNotes = String(b.siteNotes || "");
    const updatedBy = String(actorUid || b.updatedBy || "ui");

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Sealed operational records are immutable. Reject note saves
    // post-closure; post-closure context must go through the
    // addendum model (PR 43).
    const sealIncSnap = await db.collection("incidents").doc(incidentId).get();
    const sealIncStatus = String((sealIncSnap.exists ? (sealIncSnap.data() || {}) : {}).status || "").toLowerCase();
    if (sealIncStatus === "closed") {
      return j(res, 409, {
        ok: false,
        error: "incident_closed",
        detail: "Operational record is sealed — file an addendum to attach supplemental context.",
      });
    }

    // Notes content writes to the canonical top-level path
    // `incidents/{incidentId}/notes/main` to match what the deployed
    // production `getIncidentNotesV1` reads. The prior org-scoped
    // path (`orgs/{orgId}/incidents/{incidentId}/notes/main`) was a
    // dark-write: no reader on production looks there, so saves
    // silently failed to surface on reload. orgId is preserved in
    // the auth gate and in the NOTES_SAVED audit emission below.
    const ref = db.doc(`incidents/${incidentId}/notes/main`);
    await ref.set(
      {
        incidentNotes,
        siteNotes,
        updatedBy,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

        // Emit audit timeline event
    try {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "NOTES_SAVED",
        actor: updatedBy || "ui",
        sessionId: null,
        refId: null,
        meta: {
          incidentNotesLen: incidentNotes.length,
          siteNotesLen: siteNotes.length,
        },
      });
    } catch (e) {
      console.error("NOTES_SAVED emit failed", e);
    }

return j(res, 200, { ok: true, orgId, incidentId });
  } catch (e) {
    console.error("saveIncidentNotesV1 error", e);
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
