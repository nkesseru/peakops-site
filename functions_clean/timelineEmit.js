const { FieldValue } = require("firebase-admin/firestore");
const { resolveIncidentRef } = require("./_incidentPath");

function clean(s, max=120) {
  return String(s || "").trim().slice(0, max);
}

function normGps(gps) {
  if (!gps || typeof gps !== "object") return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const accuracyM = gps.accuracyM == null ? null : Number(gps.accuracyM);
  const source = clean(gps.source || "device", 24);
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : null, source };
}

/**
 * Emit a timeline event under the canonical incident path.
 *
 * Uses resolveIncidentRef to pick the same parent that getTimelineEventsV1
 * reads from: prefers orgs/{orgId}/incidents/{incidentId}/timeline_events,
 * falls back to incidents/{incidentId}/timeline_events only for legacy docs
 * that live at the top-level collection. This keeps emit and read aligned
 * so the UI's `hasArrival`, `_hasNotes`, `_hasSession`, and `currentStage`
 * derive from real backend state — localStorage stays a pure fallback.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.incidentId
 * @param {string} args.type  e.g. FIELD_ARRIVED, EVIDENCE_ADDED
 * @param {string} [args.sessionId]
 * @param {string} [args.refId] evidenceId/materialId/etc
 * @param {object} [args.gps]
 * @param {object} [args.meta]
 * @param {string} [args.actor]   Backwards-compatible role-style string
 *                                ("field", "ui", "supervisor_ui", etc.)
 * @param {string} [args.actorUid] PEAKOPS_ACTOR_UID_V1 (2026-05-18, PR 40
 *                                 Phase A): optional verified Bearer-token
 *                                 uid of the human actor. Persisted as a
 *                                 separate field so existing `actor`
 *                                 semantics don't change.
 */
async function emitTimelineEvent(args = {}) {
  const orgId = clean(args.orgId, 64);
  const incidentId = clean(args.incidentId, 128);
  const type = clean(args.type, 64);
  if (!orgId || !incidentId || !type) return null;

  const { ref: incRef, source } = await resolveIncidentRef(orgId, incidentId);
  const docRef = incRef.collection("timeline_events").doc();

  const payload = {
    orgId,
    incidentId,
    type,
    occurredAt: FieldValue.serverTimestamp(),
    sessionId: args.sessionId ? clean(args.sessionId, 128) : null,
    refId: args.refId ? clean(args.refId, 128) : null,
    gps: normGps(args.gps),
    actor: args.actor ? clean(args.actor, 64) : null,
    actorUid: args.actorUid ? clean(args.actorUid, 64) : null,
    meta: args.meta && typeof args.meta === "object" ? args.meta : null,
    v: 1,
    _pathSource: source,
  };

  await docRef.set(payload, { merge: true });
  return { id: docRef.id, source };
}

module.exports = { emitTimelineEvent };
