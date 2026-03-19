const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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
 * Emits a timeline event to incidents/{incidentId}/timeline_events/{autoId}
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.incidentId
 * @param {string} args.type  e.g. FIELD_ARRIVED, EVIDENCE_ADDED
 * @param {string} [args.sessionId]
 * @param {string} [args.refId] evidenceId/materialId/etc
 * @param {object} [args.gps]
 * @param {object} [args.meta]
 * @param {string} [args.actor]
 */
async function emitTimelineEvent(args = {}) {
  const db = getFirestore();
  const orgId = clean(args.orgId, 64);
  const incidentId = clean(args.incidentId, 128);
  const type = clean(args.type, 64);
  if (!orgId || !incidentId || !type) return null;

  const docRef = db.collection("incidents").doc(incidentId).collection("timeline_events").doc();

  const payload = {
    orgId,
    incidentId,
    type,
    occurredAt: FieldValue.serverTimestamp(),
    sessionId: args.sessionId ? clean(args.sessionId, 128) : null,
    refId: args.refId ? clean(args.refId, 128) : null,
    gps: normGps(args.gps),
    actor: args.actor ? clean(args.actor, 64) : null,
    meta: args.meta && typeof args.meta === "object" ? args.meta : null,
    v: 1
  };

  await docRef.set(payload, { merge: true });
  return { id: docRef.id };
}

module.exports = { emitTimelineEvent };
