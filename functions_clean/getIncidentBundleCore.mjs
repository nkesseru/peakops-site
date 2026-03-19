// Minimal stub to unblock emulator boot.
// TODO: replace with real implementation or move the helper into exportRegPacketV1.mjs.
import { getFirestore } from "firebase-admin/firestore";

/**
 * Return a very small "bundle-like" object so exportRegPacketV1 can proceed.
 * This is intentionally conservative: it fetches only the incident doc.
 */
export async function getIncidentBundleCore({ orgId, incidentId }) {
  if (!orgId || !incidentId) throw new Error("Missing orgId/incidentId");
  const db = getFirestore();

  const incRef = db.collection("incidents").doc(String(incidentId));
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("Incident not found");

  return {
    ok: true,
    orgId,
    incidentId,
    incident: { id: incSnap.id, ...incSnap.data() },
    filings: [],
    logs: {},
    timelineMeta: null,
  };
}
