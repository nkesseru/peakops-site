require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}
function isEmu() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
}
function emuStorageHost() {
  return String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").trim();
}
function emuDownloadUrl(bucket, storagePath) {
  const host = emuStorageHost();
  return `http://${host}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(storagePath)}?alt=media`;
}
async function writeJson(fp, obj) {
  await fs.promises.writeFile(fp, JSON.stringify(obj, null, 2), "utf8");
}
async function fetchEvidenceBytes(bucket, storagePath) {
  const url = emuDownloadUrl(bucket, storagePath);
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`evidence_download_failed ${r.status} ${storagePath}`);
  return Buffer.from(await r.arrayBuffer());
}
function runZip(cwd, outZip) {
  return new Promise((resolve, reject) => {
    execFile("zip", ["-r", "-q", outZip, "."], { cwd }, (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

exports.exportIncidentPacketV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);

    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });

    const [jobsSnap, evSnap, tlSnap] = await Promise.all([
      incRef.collection("jobs").get(),
      incRef.collection("evidence_locker").get(),
      incRef.collection("timeline_events").get(),
    ]);

    const incident = { id: incSnap.id, ...incSnap.data() };
    const jobs = jobsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const evidence = evSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const timeline = tlSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `peakops_packet_${incidentId}_`));
    const evidenceDir = path.join(workDir, "evidence");
    await fs.promises.mkdir(evidenceDir, { recursive: true });

    await writeJson(path.join(workDir, "incident.json"), incident);
    await writeJson(path.join(workDir, "jobs.json"), jobs);
    await writeJson(path.join(workDir, "evidence_locker.json"), evidence);
    await writeJson(path.join(workDir, "timeline_events.json"), timeline);

    const downloaded = [];
    const skipped = [];

    for (let i = 0; i < evidence.length; i++) {
      const ev = evidence[i] || {};
      const f = ev.file || {};
      const b = String(f.bucket || ev.bucket || bucket).trim();
      const sp = String(f.storagePath || ev.storagePath || "").trim();
      if (!sp) { skipped.push({ id: ev.id, reason: "no_storagePath" }); continue; }

      const label = String(ev.label || (Array.isArray(ev.labels) ? ev.labels[0] : "") || "").trim();
      const orig = String(f.originalName || f.fileName || "").trim();
      const base = (label || orig || ev.id || `evidence_${i+1}`).replace(/[^\w.\-]+/g, "_").slice(0, 120);
      const ext = (orig.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0] || "";
      const outName = `${String(i+1).padStart(2,"0")}__${base}${ext || ""}`;

      try {
        const buf = await fetchEvidenceBytes(b, sp);
        await fs.promises.writeFile(path.join(evidenceDir, outName), buf);
        downloaded.push({ id: ev.id, name: outName, storagePath: sp });
      } catch (e) {
        skipped.push({ id: ev.id, storagePath: sp, reason: String(e?.message || e) });
      }
    }

    await writeJson(path.join(workDir, "manifest.json"), {
      ok: true,
      orgId,
      incidentId,
      generatedAt: new Date().toISOString(),
      bucket,
      counts: { jobs: jobs.length, evidence: evidence.length, timeline: timeline.length },
      downloaded,
      skipped,
      emulator: isEmu(),
    });

    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const zipName = `${ts}__packet.zip`;
    const zipPath = path.join(os.tmpdir(), `peakops_${incidentId}_${zipName}`);

    await runZip(workDir, zipPath);  

    const outStoragePath = `exports/incidents/${incidentId}/${zipName}`;
    await bucketObj.file(outStoragePath).save(await fs.promises.readFile(zipPath), {
      contentType: "application/zip",
      resumable: false,
      metadata: { cacheControl: "no-store" },
    });

    const url = isEmu() ? emuDownloadUrl(bucket, outStoragePath) : outStoragePath;
    
        await db.doc(`incidents/${incidentId}`).set({
      packetMeta: {
        status: "ready",
        bucket,
        storagePath: outStoragePath,
        exportedAt: new Date().toISOString(),
        evidenceCount: downloaded.length + skipped.length,
        exportedCount: downloaded.length,
        skippedCount: skipped.length,
        jobCount: Array.isArray(jobs) ? jobs.length : 0,
      },
      updatedAt: new Date().toISOString(),
    }, { merge: true });

return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      bucket,
      storagePath: outStoragePath,
      url,
      downloaded: downloaded.length,
      skipped: skipped.length,
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
