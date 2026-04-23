const { getFirestore } = require("firebase-admin/firestore");

/**
 * Resolve the single canonical DocumentReference for an incident.
 *
 * Why this exists: timeline events and notes subcollections were historically
 * split between two possible parent paths:
 *   - orgs/{orgId}/incidents/{incidentId}   (canonical, created by createIncidentV1)
 *   - incidents/{incidentId}                (legacy top-level, used by demo seeds)
 *
 * Writes used to hard-code the top-level path while reads preferred canonical,
 * producing empty subcollections for incidents that live at the canonical path.
 * Every write and every read now funnels through this helper so emit and read
 * resolve to the same parent.
 *
 * Resolution order:
 *   1. orgs/{orgId}/incidents/{incidentId} — use if it exists.
 *   2. incidents/{incidentId}              — fallback only for legacy docs.
 *   3. orgs/{orgId}/incidents/{incidentId} — default when neither exists,
 *                                            so brand-new data lands canonically.
 *
 * @param {string} orgId
 * @param {string} incidentId
 * @returns {Promise<{ ref: FirebaseFirestore.DocumentReference, exists: boolean, source: "orgs" | "top_level" }>}
 */
async function resolveIncidentRef(orgId, incidentId) {
  const db = getFirestore();
  const canonical = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
  const canonicalSnap = await canonical.get();
  if (canonicalSnap.exists) {
    return { ref: canonical, exists: true, source: "orgs" };
  }

  const legacy = db.collection("incidents").doc(incidentId);
  const legacySnap = await legacy.get();
  if (legacySnap.exists) {
    return { ref: legacy, exists: true, source: "top_level" };
  }

  return { ref: canonical, exists: false, source: "orgs" };
}

module.exports = { resolveIncidentRef };
