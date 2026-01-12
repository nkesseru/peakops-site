const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function pickTs(x) {
  if (!x) return null;
  // Firestore Timestamp
  if (typeof x === "object" && typeof x._seconds === "number") return x._seconds * 1000;
  if (typeof x === "object" && typeof x.seconds === "number") return x.seconds * 1000;
  // ISO string
  if (typeof x === "string") {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // --- Incident read (optional but preferred) ---
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    const incidentOrg = incident?.orgId || incident?.orgid || null;
    const createdAtMs = pickTs(incident?.createdAt) ?? pickTs(incident?.created_at) ?? null;

    // Baseline valid = exists + org matches + has createdAt
    const baselineOk = !!(incident && incidentOrg && String(incidentOrg) === String(orgId) && createdAtMs);

    // --- Timeline (safe, but now anchored to incident.createdAt when present) ---
    const t0 = createdAtMs ? new Date(createdAtMs).toISOString() : null;
    const timeline = [
      { t: "T+0",   at: t0, title: "Incident created",   detail: "Basic incident record exists." },
      { t: "T+5m",  at: null, title: "Timeline generated", detail: "Events ordered oldest → newest." },
      { t: "T+10m", at: null, title: "Filings generated",  detail: "DIRS / OE-417 / NORS / SAR payloads created." },
      { t: "T+15m", at: null, title: "Packet exported",    detail: "ZIP + hashes produced for audit." },
    ];

    // --- Packet readiness (v1: read incident meta if present) ---
    const filingsReady = !!incident?.filingsMeta;
    const exportReady  = !!incident?.packetMeta || !!incident?.packetHash || !!incident?.exportMeta;

    const steps = [
      { key: "intake",   title: "Intake",          hint: baselineOk ? "Baseline valid ✅ (auto)" : "Confirm incident exists + baseline fields.", status: baselineOk ? "DONE" : "TODO" },
      { key: "timeline", title: "Build Timeline",  hint: "Generate timeline events + verify ordering.", status: "TODO" },
      { key: "filings",  title: "Generate Filings",hint: "Build DIRS / OE-417 / NORS / SAR payloads.", status: filingsReady ? "DONE" : "TODO" },
      { key: "export",   title: "Export Packet",   hint: "Create immutable shareable artifact (ZIP + hashes).", status: exportReady ? "DONE" : "TODO" },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps, timeline, filingsReady, exportReady }
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});
