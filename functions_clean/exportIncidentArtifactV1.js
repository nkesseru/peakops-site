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

function getArchiver() {
  try {
    return require("archiver");
  } catch {
    return null;
  }
}

function createZipBase64(files) {
  return new Promise((resolve, reject) => {
    const archiver = getArchiver();
    if (!archiver) {
      reject(new Error("archiver_missing"));
      return;
    }
    const out = [];
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("warning", (err) => {
      if (err?.code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);
    archive.on("data", (chunk) => out.push(chunk));
    archive.on("end", () => {
      resolve(Buffer.concat(out).toString("base64"));
    });
    for (const f of files) {
      archive.append(String(f.content || ""), { name: String(f.name || "file.txt") });
    }
    archive.finalize().catch(reject);
  });
}

exports.exportIncidentArtifactV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = req.body || {};
    const orgId = String(body.orgId || "").trim();
    const incidentId = String(body.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return j(res, 400, { ok: false, error: "orgId and incidentId required" });
    }

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });

    const incident = { id: incSnap.id, ...(incSnap.data() || {}) };
    const incidentOrgId = String(incident.orgId || "").trim();
    if (!incidentOrgId) return j(res, 400, { ok: false, error: "incident_org_missing" });

    const emulatorBypass = isEmulatorRuntime() && orgId === incidentOrgId;
    if (!emulatorBypass) {
      const actor = await resolveActor(req, body, req.query || {});
      await requireOrgMember(db, incidentOrgId, actor, { requiredRoles: [] });
      if (orgId !== incidentOrgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    let jobsQuery = incRef.collection("jobs").orderBy("createdAt", "desc");
    if (orgId !== incidentOrgId) {
      jobsQuery = jobsQuery.where("assignedOrgId", "==", orgId);
    }
    const jobsSnap = await jobsQuery.limit(500).get();
    const jobs = jobsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

    const evSnap = await incRef.collection("evidence_locker").orderBy("storedAt", "desc").limit(500).get();
    const evidence = evSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((d) => String(d.orgId || "") === incidentOrgId);

    const artifact = {
      incident,
      jobs,
      evidence,
      generatedAt: new Date().toISOString(),
    };

    const base64Zip = await createZipBase64([
      { name: "incident.json", content: JSON.stringify(artifact.incident, null, 2) },
      { name: "jobs.json", content: JSON.stringify(artifact.jobs, null, 2) },
      { name: "evidence.json", content: JSON.stringify(artifact.evidence, null, 2) },
    ]);

    return j(res, 200, {
      ok: true,
      filename: `incident_${incidentId}.zip`,
      base64Zip,
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

