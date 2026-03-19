const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

exports.getIncidentPacketMetaV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Incident not found" });
    }

    const data = snap.data() || {};
    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      packetMeta: data.packetMeta || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
