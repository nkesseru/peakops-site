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
const { refreshReadinessCache } = require("./_readiness");

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

    // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
    // Optional bypass fields. Saved verbatim when present so the
    // Summary / report renderer can surface "No note needed" with
    // the user-acknowledged reason. Backward compatible — older
    // clients that don't send these fields are unchanged.
    const notesStatusRaw = String(b.notesStatus || "").trim().toLowerCase();
    const notesStatus =
      notesStatusRaw === "bypassed" || notesStatusRaw === "saved"
        ? notesStatusRaw
        : "";
    const notesBypassReason = String(b.notesBypassReason || "").trim();

    const ref = db.doc(`incidents/${incidentId}/notes/main`);
    const doc = {
      incidentNotes,
      siteNotes,
      updatedBy,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (notesStatus) doc.notesStatus = notesStatus;
    if (notesBypassReason) doc.notesBypassReason = notesBypassReason;
    await ref.set(doc, { merge: true });

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
          notesStatus: notesStatus || undefined,
          notesBypassReason: notesBypassReason || undefined,
        },
      });
    } catch (e) {
      console.error("NOTES_SAVED emit failed", e);
    }

    // PEAKOPS_READINESS_FRESHNESS_V1 (PR 108) — refresh readinessCache
    // so the field-notes check flips on the next list/read without
    // waiting for a Summary view. Helper swallows errors. Note: the
    // helper loads incidents/{id}/notes/main so the evaluator sees the
    // value we just wrote.
    await refreshReadinessCache({ orgId, incidentId });

return j(res, 200, { ok: true, orgId, incidentId });
  } catch (e) {
    console.error("saveIncidentNotesV1 error", e);
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
