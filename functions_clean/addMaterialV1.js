const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function normNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// POST body:
// { orgId, incidentId, sessionId, category, name, qty, unit, notes?, baba? }
exports.addMaterialV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok:false, error:"POST required" });

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    const category = mustStr(body.category, "category").toUpperCase();
    const name = mustStr(body.name, "name");
    const qty = normNum(body.qty, 1);
    const unit = String(body.unit || "ea");
    const notes = String(body.notes || "").slice(0, 500);

    const baba = body.baba && typeof body.baba === "object"
      ? {
          originCountry: String(body.baba.originCountry || ""),
          manufacturer: String(body.baba.manufacturer || ""),
          domesticContentPercent: normNum(body.baba.domesticContentPercent, null),
          certEvidenceId: String(body.baba.certEvidenceId || "")
        }
      : null;

    const db = getFirestore();

    // verify session exists (org-scoped)
    const sesRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);

    const sesSnap = await sesRef.get();
    if (!sesSnap.exists) return j(res, 404, { ok:false, error:"session not found" });

    const matRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("materials").doc();

    const now = FieldValue.serverTimestamp();

    await matRef.set({
      orgId,
      incidentId,
      sessionId,
      materialId: matRef.id,
      category,
      name,
      qty,
      unit,
      notes,
      baba,
      addedAt: now,
      version: 1
    });

    await emitTimelineEvent({ orgId, incidentId, type: "MATERIAL_ADDED", sessionId, refId: matRef.id, actor: "field" });

    return j(res, 200, {
      ok:true,
      orgId,
      incidentId,
      sessionId,
      materialId: matRef.id
    });
  } catch (e) {
    return j(res, 400, { ok:false, error:String(e?.message || e) });
  }
});
