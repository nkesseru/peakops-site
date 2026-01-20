/**
 * generateDIRSV1
 * Creates a real-ish DIRS payload from Incident + Timeline.
 * Safe defaults: only fields we can confidently produce.
 */
const admin = require("firebase-admin");

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function isoNow() {
  return new Date().toISOString();
}

function safeStr(x) {
  return x == null ? "" : String(x);
}

exports.generateDIRSV1 = async function generateDIRSV1(req, res) {
  try {
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();

    const orgId = safeStr(req.query.orgId);
    const incidentId = safeStr(req.query.incidentId);
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incident = incSnap.exists ? ({ id: incSnap.id, ...incSnap.data() }) : null;

    // Pull up to 200 timeline events (optional)
    let timeline = [];
    try {
      const tSnap = await incRef.collection("timeline").orderBy("occurredAt", "asc").limit(200).get();
      timeline = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}

    // Very conservative “start time” guess:
    // use incident.createdAt (if firestore timestamp) else now
    let startTime = isoNow();
    const createdAt = incident && incident.createdAt;
    if (createdAt && typeof createdAt === "object" && typeof createdAt._seconds === "number") {
      startTime = new Date(createdAt._seconds * 1000).toISOString();
    } else if (typeof createdAt === "string") {
      const t = Date.parse(createdAt);
      if (Number.isFinite(t)) startTime = new Date(t).toISOString();
    }

    // If we have a timeline event with occurredAt, use first occurredAt
    if (timeline.length) {
      const first = timeline[0];
      const occ = first && first.occurredAt;
      if (typeof occ === "string") {
        const t = Date.parse(occ);
        if (Number.isFinite(t)) startTime = new Date(t).toISOString();
      } else if (occ && typeof occ === "object" && typeof occ._seconds === "number") {
        startTime = new Date(occ._seconds * 1000).toISOString();
      }
    }

    // Minimal DIRS payload (we’ll enrich later)
    const payload = {
      schemaVersion: "dirs.v1",
      orgId,
      incidentId,
      contractId: incident?.contractId || null,
      title: incident?.title || "Incident",
      status: "DRAFT",
      eventType: "OUTAGE",
      startTime,
      affectedServices: [],
      estimatedCustomersAffected: null,
      notes: "Auto-generated DIRS stub (v1). Enrich fields later.",
    };

    const filingDoc = {
      type: "DIRS",
      schemaVersion: "dirs.v1",
      orgId,
      incidentId,
      status: "GENERATED",
      present: true,
      generatedAt: isoNow(),
      payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Store under incident-scoped filings
    await incRef.collection("filings").doc("dirs").set(filingDoc, { merge: true });

    return send(res, 200, { ok: true, orgId, incidentId, filing: { id: "dirs", ...filingDoc } });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
};
