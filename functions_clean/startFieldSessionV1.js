const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function newId(prefix) {
  const rand = Math.random().toString(16).slice(2, 10);
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${prefix}_${t}_${rand}`;
}

exports.startFieldSessionV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const techUserId = mustStr(body.techUserId, "techUserId");
    const requestedBy = String(body.requestedBy || "ui");

    const db = getFirestore();
    const base = db.collection("orgs").doc(orgId).collection("incidents").doc(incidentId);
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const inc = incSnap.exists ? (incSnap.data() || {}) : {};
    const curStatus = String(inc.status || "").toLowerCase();
    if (curStatus === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed", detail: "Incident is read-only" });
    }
    if (curStatus && curStatus !== "open" && curStatus !== "in_progress" && curStatus !== "submitted") {
      return j(res, 409, { ok: false, error: "invalid_transition", detail: `unsupported incident.status=${curStatus}` });
    }

    const sessionId = newId("ses");
    const now = FieldValue.serverTimestamp();

    await base.collection("fieldSessions").doc(sessionId).set(
      { orgId, incidentId, sessionId, techUserId, status: "IN_PROGRESS", startedAt: now, requestedBy, version: 1 },
      { merge: true }
    );

    if (!curStatus || curStatus === "open") {
      await incRef.set(
        {
          orgId,
          incidentId,
          status: "in_progress",
          updatedAt: now,
          inProgressAt: now,
        },
        { merge: true }
      );
    }

    return j(res, 200, { ok: true, orgId, incidentId, sessionId, status: "IN_PROGRESS" });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
