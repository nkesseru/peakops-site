require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const {
  requireEntitlement,
  httpStatusFromEntitlementError,
} = require("./_entitlement");
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
// PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
// stableSortKeys + stableStringify: produce byte-identical JSON for the
// same input object regardless of how its keys were originally inserted.
// Used for original-record/ files so re-exporting the same incident
// produces the same originalRecordHash.
function stableSortKeys(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stableSortKeys);
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = stableSortKeys(obj[k]);
    return out;
  }
  return obj;
}
function stableStringify(obj) {
  return JSON.stringify(stableSortKeys(obj), null, 2);
}
async function writeStableJson(fp, obj) {
  await fs.promises.writeFile(fp, stableStringify(obj), "utf8");
}
// Walk a directory recursively in deterministic order.
async function walkFiles(rootDir) {
  const out = [];
  async function recur(dir, prefix) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await recur(full, rel);
      } else if (e.isFile()) {
        out.push({ relPath: rel, fullPath: full });
      }
    }
  }
  await recur(rootDir, "");
  return out;
}
// Compute the deterministic originalRecordHash. The hash file itself is
// excluded from the input (recursion guard).
async function computeOriginalRecordHash(originalRecordDir, excludeRelPath) {
  const files = await walkFiles(originalRecordDir);
  const filtered = files.filter((f) => f.relPath !== excludeRelPath);
  const perFile = {};
  for (const f of filtered) {
    const buf = await fs.promises.readFile(f.fullPath);
    perFile[f.relPath] = require("crypto").createHash("sha256").update(buf).digest("hex");
  }
  const manifestStr = stableStringify(perFile);
  const hash = require("crypto").createHash("sha256").update(manifestStr, "utf8").digest("hex");
  return { hash: `sha256:${hash}`, perFile };
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

    // PEAKOPS_ENTITLEMENT_GATE_V1 (2026-05-13)
    // Sprint 1 entitlement spine: gate signed-packet generation on
    // the riskDefenseModule entitlement. Runs immediately after
    // orgId/incidentId validation and before any Firestore reads.
    // Failure paths return 402 + structured { reason, featureKey }
    // so the client surfaces the right UpgradePrompt copy. No
    // artifact logic is touched.
    try {
      await requireEntitlement(orgId, "riskDefenseModule");
    } catch (e) {
      console.warn("[exportIncidentPacketV1] entitlement_denied", {
        fn: "exportIncidentPacketV1",
        orgId,
        incidentId,
        featureKey: "riskDefenseModule",
        reason: (e && e.details && e.details.reason) || null,
        code: e && e.code,
      });
      return j(res, httpStatusFromEntitlementError(e), {
        ok: false,
        error: (e && e.details && e.details.reason) || "entitlement_required",
        featureKey: "riskDefenseModule",
      });
    }
    console.log("[exportIncidentPacketV1] entitlement_ok", {
      fn: "exportIncidentPacketV1",
      orgId,
      incidentId,
      featureKey: "riskDefenseModule",
    });

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
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Sort by doc.id for stable ordering across re-exports.
    const jobs = jobsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const evidence = evSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const timeline = tlSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

    if (truthMismatchReasons.length > 0) {
      return j(res, 409, {
        ok: false,
        error: "truth_mismatch",
        reasons: truthMismatchReasons,
      });
    }

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `peakops_packet_${incidentId}_`));
    // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45)
    // The operational record's sealed contents move into
    // original-record/. An unzipper sees the two-section split
    // (original-record/ + supplemental-addenda/) immediately.
    const originalRecordDir = path.join(workDir, "original-record");
    await fs.promises.mkdir(originalRecordDir, { recursive: true });
    const evidenceDir = path.join(originalRecordDir, "evidence");
    await fs.promises.mkdir(evidenceDir, { recursive: true });

    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Stable serialization (sorted keys) for byte-identical bytes
    // across re-exports.
    await writeStableJson(path.join(originalRecordDir, "incident.json"), incident);
    await writeStableJson(path.join(originalRecordDir, "jobs.json"), jobs);
    await writeStableJson(path.join(originalRecordDir, "evidence_locker.json"), evidence);
    await writeStableJson(path.join(originalRecordDir, "timeline_events.json"), timelineNormalized);

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

    // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45)
    // Operational-record manifest moves under original-record/.
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // generatedAt frozen to incident.closedAt for byte-stability.
    const _closedAtIso = (() => {
      try {
        if (!incident || !incident.closedAt) return null;
        if (typeof incident.closedAt === "string") return incident.closedAt;
        if (typeof incident.closedAt.toDate === "function") {
          return incident.closedAt.toDate().toISOString();
        }
        if (incident.closedAt._seconds) {
          return new Date(Number(incident.closedAt._seconds) * 1000).toISOString();
        }
      } catch (_) { /* fall through */ }
      return null;
    })();
    await writeStableJson(path.join(originalRecordDir, "manifest.json"), {
      ok: true,
      orgId,
      incidentId,
      generatedAt: _closedAtIso,
      bucket,
      counts: { jobs: approvedJobs.length, evidence: evidence.length, timeline: timelineNormalized.length },
      evidenceByJob,
      downloaded,
      skipped,
      emulator: isEmu(),
    });

    // PEAKOPS_SEALED_PACKET_V2_ADDENDA_V1 (2026-05-19, PR 45)
    // Fetch supplemental addenda (PR 43 collection). Failure here
    // is non-fatal — the packet still emits with an empty
    // supplemental section.
    let addenda = [];
    try {
      const addSnap = await incRef
        .collection("addenda")
        .orderBy("createdAt", "asc")
        .limit(500)
        .get();
      addenda = addSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[exportIncidentPacketV1] addenda_fetch_failed", e && e.message);
      addenda = [];
    }

    // PEAKOPS_SEALED_PACKET_V2_SUPPLEMENTAL_V1 (2026-05-19, PR 45)
    // supplemental-addenda/ directory only when at least one addendum
    // exists.
    const addendaEmitted = [];
    const addendaSkipped = [];
    let supplementalSectionHash = null;
    if (addenda.length > 0) {
      const supplementalDir = path.join(workDir, "supplemental-addenda");
      const addendaRootDir = path.join(supplementalDir, "addenda");
      await fs.promises.mkdir(addendaRootDir, { recursive: true });

      for (const ad of addenda) {
        const aid = String(ad.id || ad.addendumId || "").trim();
        if (!aid) continue;
        const adDir = path.join(addendaRootDir, aid);
        await fs.promises.mkdir(adDir, { recursive: true });

        let attachmentBlock = null;
        const f = (ad.file && typeof ad.file === "object") ? ad.file : null;
        if (f && f.bucket && f.storagePath) {
          const origName = String(f.originalName || "attachment").trim();
          const safeName = origName.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "attachment";
          try {
            const buf = await fetchEvidenceBytes(String(f.bucket), String(f.storagePath));
            await fs.promises.writeFile(path.join(adDir, safeName), buf);
            const fileHash = require("crypto").createHash("sha256").update(buf).digest("hex");
            attachmentBlock = {
              filenameInPacket: safeName,
              originalName: origName,
              contentType: String(f.contentType || "application/octet-stream"),
              sizeBytes: buf.length,
              sha256: fileHash,
            };
          } catch (e) {
            addendaSkipped.push({ addendumId: aid, reason: String(e && e.message) || "attachment_download_failed" });
          }
        }

        const createdAtSec = Number((ad.createdAt && ad.createdAt._seconds) || 0);
        const filedAtIso = createdAtSec > 0 ? new Date(createdAtSec * 1000).toISOString() : null;
        const reasonRaw = String(ad.reason || "").toLowerCase();
        const reasonLabel =
          reasonRaw === "clarification" ? "Clarification" :
          reasonRaw === "customer_followup" ? "Customer follow-up" :
          reasonRaw === "audit_support" ? "Audit support" :
          reasonRaw === "other" ? "Other" :
          reasonRaw || "Addendum";

        const addendumJson = {
          addendumId: aid,
          filedAt: filedAtIso,
          filedBy: {
            uid: String(ad.createdBy || "") || null,
            label: null,            // main's mirror doesn't carry the actor-label resolver — deploy version does
          },
          reason: reasonRaw || null,
          reasonLabel,
          note: String(ad.note || ""),
          attachment: attachmentBlock,
          recordSealAtAddendumTime: ad.recordSealAtAddendumTime || null,
          relatedJobId: String(ad.relatedJobId || "") || null,
          disclaimer: "This addendum was filed after operational record closure and does not modify the original field record.",
        };
        await writeJson(path.join(adDir, "addendum.json"), addendumJson);
        addendaEmitted.push({
          addendumId: aid,
          filedAt: filedAtIso,
          filedBy: addendumJson.filedBy.uid,
          reason: reasonRaw || null,
          reasonLabel,
          hasAttachment: !!attachmentBlock,
        });
      }

      await writeJson(path.join(supplementalDir, "manifest.json"), {
        title: "Supplemental addenda",
        incidentId,
        orgId,
        generatedAt: new Date().toISOString(),
        count: addendaEmitted.length,
        skipped: addendaSkipped,
        disclaimer: "Addenda are filed after operational record closure and do not modify the original record.",
        addenda: addendaEmitted,
      });

      const supplementalHashStr = require("crypto")
        .createHash("sha256")
        .update(JSON.stringify(addendaEmitted))
        .digest("hex");
      supplementalSectionHash = `sha256:${supplementalHashStr}`;
      await fs.promises.writeFile(
        path.join(supplementalDir, "supplemental-addenda-hash.txt"),
        `${supplementalSectionHash}\n`,
        "utf8"
      );
    }

    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Compute the real originalRecordHash now that all
    // original-record/ files are written. The hash file itself is
    // excluded from the input (recursion guard).
    const _originalHashResult = await computeOriginalRecordHash(
      originalRecordDir,
      "original-record-hash.txt"
    );
    const _originalRecordHash = _originalHashResult.hash;
    await fs.promises.writeFile(
      path.join(originalRecordDir, "original-record-hash.txt"),
      _originalRecordHash + "\n",
      "utf8"
    );

    // PEAKOPS_SEALED_PACKET_V2_CHAIN_OF_CUSTODY_V1 (2026-05-19, PR 45)
    // Combined chain: operational-record timeline + addendum-filed
    // entries, sorted by ISO timestamp ascending.
    const operationalRecordEntries = timelineNormalized.map((t) => {
      const sec = Number((t.occurredAt && t.occurredAt._seconds) || 0);
      return {
        when: sec > 0 ? new Date(sec * 1000).toISOString() : null,
        kind: t.type || null,
        actor: String(t.actor || "") || null,
        origin: "operational_record",
      };
    });
    const chainEntries = [
      ...operationalRecordEntries,
      ...addendaEmitted.map((a) => ({
        when: a.filedAt,
        kind: "ADDENDUM_FILED",
        actor: a.filedBy || null,
        origin: "supplemental_addendum",
        addendumId: a.addendumId,
        reason: a.reason,
        reasonLabel: a.reasonLabel,
      })),
    ].sort((x, y) => {
      const ax = x.when ? Date.parse(x.when) : Number.POSITIVE_INFINITY;
      const ay = y.when ? Date.parse(y.when) : Number.POSITIVE_INFINITY;
      return ax - ay;
    });
    await writeJson(path.join(workDir, "chain-of-custody.json"), {
      incidentId,
      orgId,
      generatedAt: new Date().toISOString(),
      operationalRecordEventCount: timelineNormalized.length,
      supplementalAddendumCount: addendaEmitted.length,
      entries: chainEntries,
    });

    // PEAKOPS_SEALED_PACKET_V2_PACKET_VERSION_V1 (2026-05-19, PR 45)
    // packetVersion derives from existing packetMeta.reportRevision
    // (deploy's monotonic counter). On main the field may be absent;
    // initial export gets version 1, subsequent re-exports bump.
    const _existingRevision = (() => {
      const v = (incident && incident.packetMeta && incident.packetMeta.reportRevision);
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    const packetVersion = _existingRevision + 1;

    // PEAKOPS_SEALED_PACKET_V2_PACKET_MANIFEST_V1 (2026-05-19, PR 45)
    // Top-level audit manifest.
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Real hash from computeOriginalRecordHash above.
    const originalRecordHashStr = _originalRecordHash;
    const _topLevelInput = _originalRecordHash + "||" + (supplementalSectionHash || "");
    const _topLevelHash = "sha256:" + require("crypto")
      .createHash("sha256")
      .update(_topLevelInput, "utf8")
      .digest("hex");
    const packetManifest = {
      schemaVersion: 1,
      formatVersion: 2,
      incidentId,
      orgId,
      packetVersion,
      exportedAt: new Date().toISOString(),
      originalRecord: {
        closedAt: (incident && incident.closedAt) || null,
        hash: originalRecordHashStr,
        evidenceCount: evidence.length,
        jobCount: approvedJobs.length,
        timelineEventCount: timelineNormalized.length,
      },
      supplementalAddenda: {
        count: addendaEmitted.length,
        hash: supplementalSectionHash,
        addenda: addendaEmitted,
      },
      topLevelHash: _topLevelHash,
    };
    await writeJson(path.join(workDir, "packet-manifest.json"), packetManifest);

    // PEAKOPS_SEALED_PACKET_V2_README_V1 (2026-05-19, PR 45)
    // Plain-text README_FIRST.txt at top of the packet.
    const readmeLines = [
      "PEAKOPS OPERATIONAL RECORD PACKET",
      "─────────────────────────────────",
      "",
      `Incident:     ${incidentId}`,
      `Org:          ${orgId}`,
      `Closed:       ${packetManifest.originalRecord.closedAt || "(not recorded)"}`,
      `Exported:     ${packetManifest.exportedAt}`,
      `Packet ID:    ${incidentId}__v${packetVersion}`,
      "",
      "This packet contains two sections:",
      "",
      "  1. ORIGINAL OPERATIONAL RECORD  (original-record/)",
      "     The sealed field record as it existed at incident closure.",
      "     Re-exporting the same incident later produces an identical",
      "     original-record/ section (verifiable by hash). Original",
      "     record hash: " + originalRecordHashStr,
      "",
      "  2. SUPPLEMENTAL ADDENDA  (supplemental-addenda/)",
      "     Context filed after closure, in chronological order. Each",
      "     addendum identifies the filer, the time of filing, and the",
      "     stated reason. Addenda do not modify the original record —",
      "     they exist alongside it as transparent supplemental material.",
      `     Addenda included: ${addendaEmitted.length}`,
      "     Supplemental section hash: " + (supplementalSectionHash || "(none — no addenda filed)"),
      "",
      "Combined chain-of-custody record: chain-of-custody.json.",
      "",
      "This packet was generated by PeakOps.",
      "",
    ];
    await fs.promises.writeFile(path.join(workDir, "README_FIRST.txt"), readmeLines.join("\n"), "utf8");

    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const zipName = `${ts}__packet.zip`;
    const zipPath = path.join(os.tmpdir(), `peakops_${incidentId}_${zipName}`);

    await runZip(workDir, zipPath);

    // PEAKOPS_SEALED_PACKET_V2_VERSIONED_PATH_V1 (2026-05-19, PR 45)
    // Versioned storage path. Prior versions are retained at their
    // original paths (locked decision).
    const outStoragePath = `exports/incidents/${incidentId}/v${packetVersion}__${zipName}`;
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
        evidenceCount: evidence.length,
        exportedCount: downloaded.length,
        skippedCount: skipped.length,
        jobCount: approvedJobs.length,
        // PEAKOPS_SEALED_PACKET_V2_PACKETMETA_V1 (2026-05-19, PR 45)
        formatVersion: 2,
        packetVersion,
        reportRevision: packetVersion,    // mirror for deploy-branch counter convention
        originalRecordHash: _originalRecordHash,
        topLevelHash: _topLevelHash,
        supplementalAddendaHash: supplementalSectionHash,
        addendaCount: addendaEmitted.length,
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
