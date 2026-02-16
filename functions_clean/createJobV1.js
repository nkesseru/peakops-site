const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

const ALLOWED = new Set(["open", "in_progress", "complete", "review", "approved", "rejected"]);

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

async function assertIncidentOrg(db, orgId, incidentId) {
  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("incident_not_found");
  const inc = incSnap.data() || {};
  const incOrgId = String(inc.orgId || "").trim();
  if (incOrgId && incOrgId !== orgId) throw new Error("org_mismatch");
}

// POST { orgId, incidentId, title, assignedTo?, notes?, status? }
exports.createJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const title = mustStr(body.title, "title").slice(0, 160);
    const assignedTo = String(body.assignedTo || "").trim().slice(0, 120);
    const notes = String(body.notes || "").trim().slice(0, 1200);
    const status = String(body.status || "open").trim().toLowerCase();
    if (!ALLOWED.has(status)) return j(res, 400, { ok: false, error: "invalid_status" });

    const db = getFirestore();
    await assertIncidentOrg(db, orgId, incidentId);

    const now = FieldValue.serverTimestamp();
    const ref = db.collection("incidents").doc(incidentId).collection("jobs").doc();
    await ref.set(
      {
        jobId: ref.id,
        orgId,
        incidentId,
        title,
        status,
        assignedTo: assignedTo || null,
        notes: notes || null,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    return j(res, 200, { ok: true, orgId, incidentId, jobId: ref.id, status });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});

