const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { resolveActor, requireOrgMember } = require("./jobAuthz");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function linkedJobId(ev) {
  return String(ev?.jobId || ev?.evidence?.jobId || "").trim();
}

function isEmulatorRuntime() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!String(process.env.FIREBASE_EMULATOR_HUB || "").trim();
}

async function assertViewAccess({ db, actor, incidentOrgId, assignedOrgId }) {
  try {
    await requireOrgMember(db, incidentOrgId, actor, { requiredRoles: ["owner", "admin"] });
    return "incident_admin";
  } catch {}
  if (assignedOrgId) {
    try {
      await requireOrgMember(db, assignedOrgId, actor, { requiredRoles: [] });
      return "assigned_org_member";
    } catch {}
  }
  const err = new Error("forbidden");
  err.statusCode = 403;
  throw err;
}

exports.getJobV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });
    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");
    const jobId = mustStr(req.query.jobId, "jobId");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

    const db = getFirestore();
    const actor = await resolveActor(req, {}, req.query || {});

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });
    const incident = incSnap.data() || {};
    const incidentOrgId = String(incident.orgId || "").trim();
    if (!incidentOrgId) return j(res, 400, { ok: false, error: "incident_org_missing" });

    const jobRef = incRef.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
    const job = jobSnap.data() || {};
    if (String(job.incidentId || incidentId) !== incidentId) return j(res, 409, { ok: false, error: "incident_mismatch" });

    const assignedOrgId = String(job.assignedOrgId || "").trim();
    const emulatorBypass = isEmulatorRuntime() && orgId === incidentOrgId;
    if (emulatorBypass) console.log("[getJobV1] emulator bypass auth", { orgId, incidentId, jobId });
    const access = emulatorBypass
      ? "emulator_bypass"
      : await assertViewAccess({
          db,
          actor,
          incidentOrgId,
          assignedOrgId,
        });

    const evSnap = await incRef.collection("evidence_locker").limit(limit).get();
    const evidence = evSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((ev) => linkedJobId(ev) === jobId);

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      jobId,
      access,
      job: { id: jobSnap.id, ...job },
      incident: {
        id: incidentId,
        orgId: incidentOrgId,
        title: String(incident.title || incident.incidentId || incidentId),
        status: String(incident.status || "open"),
      },
      evidenceCount: evidence.length,
      evidence,
    });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
