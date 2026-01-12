import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export default async function getWorkflowV1Handler(req, res) {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) {
      res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
      return;
    }

    // Optional incident read (doesn't fail if missing)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const steps = [
      { key: "intake",   title: "Intake",            hint: "Confirm incident exists + has baseline fields.", status: "TODO" },
      { key: "timeline", title: "Build Timeline",     hint: "Generate timeline events + verify ordering.",    status: "TODO" },
      { key: "filings",  title: "Generate Filings",   hint: "Build DIRS/OE-417/NORS/SAR payloads.",        status: "TODO" },
      { key: "export",   title: "Export Packet",      hint: "Create immutable shareable artifact (ZIP + hashes).", status: "TODO" },
    ];

    res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
