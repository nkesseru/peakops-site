const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function readJson(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.rawBody) return JSON.parse(req.rawBody.toString("utf8") || "{}");
  } catch {}
  return {};
}

exports.generateTimelineV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const payload = readJson(req);
    const orgId = String(payload.orgId || req.query.orgId || "").trim();
    const incidentId = String(payload.incidentId || req.query.incidentId || "").trim();
    const requestedBy = String(payload.requestedBy || req.query.requestedBy || "unknown").trim();

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const incidentRef = db.collection("incidents").doc(incidentId);
    const snap = await incidentRef.get();

    // IMMUTABILITY_GUARD_V1
    const incident = snap.exists ? (snap.data() || {}) : {};
    const force = String((req.query && req.query.force) || (payload && payload.force) || "") === "1";
    if (incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }


    const nowIso = new Date().toISOString();
    const nowTs = Timestamp.now();

    const events = [
      {
        id: "t0_created",
        type: "INCIDENT_CREATED",
        title: "Incident created",
        message: snap.exists ? "Incident record exists." : "Incident record missing (timeline created anyway).",
        occurredAt: nowIso,
      },
      {
        id: "t1_timeline",
        type: "TIMELINE_GENERATED",
        title: "Timeline generated",
        message: "Stub timeline generated.",
        occurredAt: nowIso,
      },
    ];

    const batch = db.batch();
    const col = incidentRef.collection("timeline_events");

    for (const ev of events) {
      batch.set(
        col.doc(ev.id),
        {
          ...ev,
          orgId,
          incidentId,
          requestedBy,
          createdAt: nowTs,
          updatedAt: nowTs,
        },
        { merge: true }
      );
    }

    await batch.commit();

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      requestedBy,
      incidentExists: snap.exists,
      count: events.length,
      docs: events,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
