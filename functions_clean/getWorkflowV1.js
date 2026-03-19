const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const incidentRef = db.collection("incidents").doc(incidentId);
    const incidentSnap = await incidentRef.get();
    if (!incidentSnap.exists) {
      return res.status(404).json({ ok: false, error: "Incident not found" });
    }

    const packetMeta = (incidentSnap.data() || {}).packetMeta || null;
    const exportReady = !!(packetMeta && packetMeta.packetHash);

    // ---- derive readiness from Firestore ----
    const filingsSnap = await incidentRef.collection("filings").limit(1).get();
    const filingsReady = filingsSnap.size > 0;

    const timelineSnap = await incidentRef.collection("timeline_events").limit(1).get();
    const timelineReady = timelineSnap.size > 0;

    // ---- build workflow deterministically ----
    const steps = [
      { key: "intake",   title: "Intake",           status: "DONE" },
      { key: "timeline", title: "Build Timeline",   status: timelineReady ? "DONE" : "TODO" },
      { key: "filings",  title: "Generate Filings", status: filingsReady ? "DONE" : "TODO" },
      { key: "export",   title: "Export Packet",    status: exportReady ? "DONE" : "TODO" },
    ];

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident: { id: incidentId, ...incidentSnap.data() },
      workflow: {
        version: "v1",
        steps,
        filingsReady,
        exportReady: exportReady,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
