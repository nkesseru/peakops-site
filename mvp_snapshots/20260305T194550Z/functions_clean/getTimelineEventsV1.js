const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function applyCors(req, res) {
  const origin = String(req.get?.("origin") || "");
  const allowOrigin = origin === "http://127.0.0.1:3001" ? origin : "http://127.0.0.1:3001";
  res.set("Access-Control-Allow-Origin", allowOrigin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-peakops-demo");
  res.set("Access-Control-Allow-Credentials", "true");
}

function isDemoBypass(req) {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" &&
    String(req.get?.("x-peakops-demo") || "") === "1";
}

exports.getTimelineEventsV1 = onRequest(async (req, res) => {
  applyCors(req, res);
  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    return res.status(204).send("");
  }
  try {
    if (String(req.method || "").toUpperCase() !== "GET") {
      return send(res, 405, { ok: false, error: "method_not_allowed" });
    }
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);

    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incRef = db.collection("incidents").doc(incidentId);

    // Optional: check org match if the doc exists
    const incSnap = await incRef.get();
    if (incSnap.exists) {
      const data = incSnap.data() || {};
      if (!isDemoBypass(req) && data.orgId && String(data.orgId) !== orgId) {
        return send(res, 404, { ok: false, error: "Incident not found" });
      }
    }

    // Pull timelineEvents subcollection if present
    let q = incRef.collection("timeline_events").orderBy("occurredAt", "asc").limit(limit);
    const snap = await q.get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      count: docs.length,
      docs,
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
