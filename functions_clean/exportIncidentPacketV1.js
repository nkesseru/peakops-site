require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}
// PEAKOPS_EXPORT_EMU_GATE_V2 (2026-04-24)
// Canonical emulator flags only — drop the FIREBASE_STORAGE_EMULATOR_HOST
// disjunct that leaks into prod via the checked-in env.runtime.
function isEmu() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB;
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
// PEAKOPS_EXPORT_FETCH_BYTES_V2 (2026-04-24)
// Previously this hard-coded a 127.0.0.1:9199 emulator URL, making every
// evidence download fail in production. Use the Admin SDK's file.download()
// which transparently talks to GCS in prod and the Storage emulator in dev
// (the admin library honors FIREBASE_STORAGE_EMULATOR_HOST when set).
async function fetchEvidenceBytes(bucket, storagePath) {
  const [buf] = await getStorage().bucket(bucket).file(storagePath).download();
  return buf;
}
// PEAKOPS_EXPORT_ZIP_V2 (2026-04-24)
// Replace `execFile("zip", …)` with node-native archiver. The GCF Node 20
// runtime has no `zip` binary; the old execFile call failed with ENOENT and
// returned 500 before any bytes hit Storage. `archiver` is already a
// functions_clean package.json dep and the same lib exportIncidentArtifactV1
// uses.
function runZip(cwd, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err?.code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(cwd, false);
    archive.finalize();
  });
}
function isApprovedJob(job) {
  const rs = String(job?.reviewStatus || "").trim().toLowerCase();
  const st = String(job?.status || "").trim().toLowerCase();
  return rs === "approved" || st === "approved";
}
function getEvidenceJobId(ev) {
  const top = String(ev?.jobId || "").trim();
  if (top) return top;
  const nested = String(ev?.evidence?.jobId || "").trim();
  return nested || null;
}
function normalizeTimelineType(type) {
  return String(type || "").trim().toLowerCase();
}


exports.exportIncidentPacketV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");

    const db = getFirestore();
    let incRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let incSnap = await incRef.get();
    if (!incSnap.exists) {
      incRef = db.collection("incidents").doc(incidentId);
      incSnap = await incRef.get();
    }
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });

    // PEAKOPS_EXPORT_PATH_ALIGN_V1
    // Subcollections on this app are split across two parents. Writers that
    // hardcode the legacy top-level path:
    //   - createJobV1         → incidents/{id}/jobs
    //   - addEvidenceV1       → incidents/{id}/evidence_locker   (via evidenceRefs.mjs)
    //   - assignEvidenceToJobV1, setEvidenceLabelV1 → same legacy path
    // Timeline events are written through the unified emitTimelineEvent
    // resolver (functions_clean/_incidentPath.js), which lands them under the
    // incident doc that *actually exists* — canonical for createIncidentV1
    // incidents, legacy for seed-era incidents. Reading all three subcollections
    // off the same resolved incRef (as the original code did) produces empty
    // jobs + evidence arrays for any hybrid incident (canonical doc + legacy
    // subcollections), which is the normal shape for createIncidentV1 output.
    // Fix: read each subcollection from the parent its writers actually target.
    const legacyIncRef = db.collection("incidents").doc(incidentId);
    const [jobsSnap, evSnap, tlSnap] = await Promise.all([
      legacyIncRef.collection("jobs").get(),
      legacyIncRef.collection("evidence_locker").get(),
      incRef.collection("timeline_events").get(),
    ]);

    const incident = { id: incSnap.id, ...incSnap.data() };
    const jobs = jobsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const evidence = evSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const timeline = tlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const approvedJobs = jobs.filter((j) => isApprovedJob(j));
    const evidenceByJob = evidence.reduce((acc, ev) => {
      const key = getEvidenceJobId(ev) || "unassigned";
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    const timelineNormalized = timeline.map((t) => ({ ...t, type: normalizeTimelineType(t?.type) }));


    const timelineCounts = timelineNormalized.reduce((acc, ev) => {
      const t = normalizeTimelineType(ev?.type);
      if (!t) return acc;
      acc[t] = Number(acc[t] || 0) + 1;
      return acc;
    }, {});

    const truthMismatchReasons = [];

    const unassigned = evidence.filter((ev) => !getEvidenceJobId(ev));
    if (unassigned.length > 0) {
      truthMismatchReasons.push(`${unassigned.length} evidence items unassigned`);
    }
    if ((timelineCounts["field_submitted"] || 0) < 1) {
      truthMismatchReasons.push("missing field_submitted");
    }
    if ((timelineCounts["incident_closed"] || 0) < 1) {
      truthMismatchReasons.push("missing incident_closed");
    }
    if ((timelineCounts["job_approved"] || 0) < approvedJobs.length) {
      truthMismatchReasons.push("missing job_approved events");
    }

    if (truthMismatchReasons.length > 0 && !isEmu()) {
      return j(res, 409, {
        ok: false,
        error: "truth_mismatch",
        reasons: truthMismatchReasons,
      });
    }

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `peakops_packet_${incidentId}_`));
    const evidenceDir = path.join(workDir, "evidence");
    await fs.promises.mkdir(evidenceDir, { recursive: true });

    await writeJson(path.join(workDir, "incident.json"), incident);
    await writeJson(path.join(workDir, "jobs.json"), jobs);
    await writeJson(path.join(workDir, "evidence_locker.json"), evidence);
    await writeJson(path.join(workDir, "timeline_events.json"), timelineNormalized);

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
      counts: { jobs: approvedJobs.length, evidence: evidence.length, timeline: timelineNormalized.length },
      evidenceByJob,
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
    const zipBuf = await fs.promises.readFile(zipPath);
    const zipSha256 = require("crypto").createHash("sha256").update(zipBuf).digest("hex");
    const exportedAt = new Date().toISOString();

        await incRef.set({
      packetMeta: {
        status: "ready",
        bucket,
        storagePath: outStoragePath,
        exportedAt,
        packetHash: zipSha256,
        sizeBytes: zipBuf.length,
        filingsCount: timeline.length > 0 ? evidence.length : 0,
        timelineCount: timelineNormalized.length,
        zipSha256,
        zipSize: zipBuf.length,
        zipGeneratedAt: exportedAt,
        evidenceCount: evidence.length,
        exportedCount: downloaded.length,
        skippedCount: skipped.length,
        jobCount: approvedJobs.length,
      },
      updatedAt: exportedAt,
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
