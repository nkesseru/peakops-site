const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { resolveIncidentRef } = require("./_incidentPath");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Lazy-loaded so notification fan-out failures can never block the
// submit itself — the in-app feed is best-effort.
let _notify = null;
try { _notify = require("./_notify"); } catch (_) { /* ignore */ }

async function hasFieldSubmittedEvent(db, incidentId, sessionId) {
  const snap = await db
    .collection("incidents").doc(incidentId)
    .collection("timeline_events")
    .where("type", "==", "FIELD_SUBMITTED")
    .where("sessionId", "==", sessionId)
    .limit(1)
    .get();
  return !snap.empty;
}

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

// POST body: { orgId, incidentId, sessionId, submittedBy? }
exports.submitFieldSessionV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok:false, error:"POST required" });

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 5: field session submit is field-or-above (the
    // field crew's terminal action). Upgraded from the Slice 3
    // membership-only gate. Runs before resolveIncidentRef /
    // sesRef.get so a non-member or viewer never triggers the
    // awaiting_review notification fan-out below.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[submitFieldSessionV1] authz_denied", {
        fn: "submitFieldSessionV1",
        orgId,
        incidentId,
        sessionId,
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
    console.log("[submitFieldSessionV1] authz_ok", {
      fn: "submitFieldSessionV1",
      orgId,
      incidentId,
      sessionId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    // submittedBy honors the verified actor uid first; body fields
    // remain as a legacy fallback for callers that pass the friendly
    // "techUserId" alias from the field UI.
    const submittedBy = String(actorUid || body.submittedBy || body.techUserId || "ui");

    const db = getFirestore();
    // PEAKOPS_STATUS_WRITE_ALIGN_V1
    // Status writes must land on the same parent that getIncidentV1 reads from,
    // so the summary header status pill reflects the latest state. Field
    // sessions themselves stay on the legacy path (startFieldSessionV1 writes
    // them there, the existing hasFieldSubmittedEvent helper reads them from
    // there).
    const { ref: incRef } = await resolveIncidentRef(orgId, incidentId);
    const sesRef = db.collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);

    const snap = await sesRef.get();
    if (!snap.exists) return j(res, 404, { ok:false, error:"session not found" });

    const data = snap.data() || {};
    if (data.status === "APPROVED") {
      return j(res, 409, { ok:false, error:"ALREADY_APPROVED" });
    }
    if (data.status === "SUBMITTED") {
      const alreadyHasEvent = await hasFieldSubmittedEvent(db, incidentId, sessionId);
      if (!alreadyHasEvent) {
        await emitTimelineEvent({ orgId, incidentId, type: "FIELD_SUBMITTED", sessionId, actor: submittedBy, meta: { backfilled: true } });
      }
      return j(res, 200, { ok:true, orgId, incidentId, sessionId, already:true });
    }

    const incSnap = await incRef.get();
    const incStatus = String((incSnap.exists ? (incSnap.data() || {}) : {}).status || "").toLowerCase();
    if (incStatus === "closed") {
      return j(res, 409, { ok:false, error:"incident_closed", detail:"Incident is read-only" });
    }
    if (incStatus && !["open","in_progress","submitted"].includes(String(incStatus).toLowerCase())) {
      return j(res, 409, { ok:false, error:"invalid_transition", detail:`unsupported incident.status=${incStatus}` });
    }

    const now = FieldValue.serverTimestamp();
    await sesRef.set(
      {
        status: "SUBMITTED",
        submittedAt: now,
        submittedBy
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "FIELD_SUBMITTED", sessionId, actor: submittedBy });
    await incRef.set(
      {
        orgId,
        incidentId,
        status: "submitted",
        submittedAt: now,
        submittedBy,
        updatedAt: now,
      },
      { merge: true }
    );

    // PEAKOPS_NOTIFICATIONS_PRODUCER_V2 (2026-05-05)
    // awaiting_review fan-out. Notifies admin + supervisor members
    // of the org so the review queue surfaces at the next bell
    // tick. No setting key — there's no per-user toggle for review
    // alerts in v1; queue work is on-by-default for the roles that
    // own it.
    //
    // Per debug-patch spec (Notifications Debug v1.1): keep the
    // actor's notification on; do NOT exclude submitter even if the
    // submitter happens to also be an admin/supervisor in this org.
    //
    // Diagnostic log format: single-line `[notify] awaiting_review
    // recipients=<n> wrote=<n>` so production log parsers don't
    // need to stitch two lines together.
    try {
      if (_notify && typeof _notify.fanOutOrgNotification === "function") {
        const _incData = incSnap.exists ? (incSnap.data() || {}) : {};
        const _incidentTitle =
          String(_incData.title || "").trim() ||
          String(_incData.name || "").trim() ||
          "An incident";
        const result = await _notify.fanOutOrgNotification({
          orgId,
          recipientRoles: ["admin", "supervisor"],
          payload: {
            type: "awaiting_review",
            title: "Incident ready for review",
            message: `${_incidentTitle} is waiting for supervisor review.`,
            incidentId,
            orgId,
            targetUrl: `/incidents/${encodeURIComponent(incidentId)}/review?orgId=${encodeURIComponent(orgId)}`,
          },
        });
        const wrote = typeof result === "number" ? result : (result?.wrote || 0);
        const recipients = typeof result === "number" ? result : (result?.recipients || result?.wrote || 0);
        // eslint-disable-next-line no-console
        console.log(`[notify] awaiting_review recipients=${recipients} wrote=${wrote}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[notify] _notify helper unavailable — awaiting_review fan-out skipped");
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[notify] awaiting_review fan-out failed", e?.message || e);
    }

    return j(res, 200, { ok:true, orgId, incidentId, sessionId, status:"SUBMITTED" });
  } catch (e) {
    return j(res, 400, { ok:false, error:String(e?.message || e) });
  }
});
