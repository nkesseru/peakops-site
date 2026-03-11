const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { resolveActor, requireOrgMember } = require("./jobAuthz");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function isEmulatorRuntime() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!String(process.env.FIREBASE_EMULATOR_HUB || "").trim();
}

async function getIncidentInfo(db, incidentId) {
  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("incident_not_found");
  const inc = incSnap.data() || {};
  const incOrgId = String(inc.orgId || "").trim();
  return { inc, incOrgId: incOrgId || "" };
}

// GET ?orgId&incidentId&limit
exports.listJobsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    if (!orgId || !incidentId) return j(res, 400, { ok: false, error: "orgId and incidentId required" });

    const db = getFirestore();
    const { incOrgId } = await getIncidentInfo(db, incidentId);
    if (!incOrgId) return j(res, 400, { ok: false, error: "incident_org_missing", count: 0, docs: [] });

    const emulatorBypass = isEmulatorRuntime() && orgId === incOrgId;
    if (emulatorBypass) {
      console.log("[listJobsV1] emulator bypass auth", { orgId, incidentId });
    } else {
      const actor = await resolveActor(req, {}, req.query || {});
      await requireOrgMember(db, orgId, actor, { requiredRoles: [] });
    }

    let q = db
      .collection("incidents")
      .doc(incidentId)
      .collection("jobs")
      .orderBy("createdAt", "desc");
    if (orgId !== incOrgId) {
      q = q.where("assignedOrgId", "==", orgId);
    }
    const snap = await q.limit(limit).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return j(res, 200, { ok: true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e), count: 0, docs: [] });
  }
});
