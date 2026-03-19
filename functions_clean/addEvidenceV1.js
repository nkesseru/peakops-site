const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { resolveEvidenceBucket } = require("./evidenceBucket");
const { normalizeContentType, isHeicEvidence } = require("./evidenceHeic");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function normGps(gps) {
  if (!gps || typeof gps !== "object") return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const accuracyM = gps.accuracyM == null ? null : Number(gps.accuracyM);
  const source = String(gps.source || "device");
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : null, source };
}

function cleanLabel(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_ -]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 24);
}

function utcStamp() {
  // 20260121T002637Z
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function fmtGps(gps) {
  if (!gps) return "GPS-NA";
  const lat = Number(gps.lat).toFixed(4);
  const lng = Number(gps.lng).toFixed(4);
  const acc = gps.accuracyM == null ? "ACC-NA" : `ACC-${Math.round(Number(gps.accuracyM))}m`;
  return `GPS-${lat}_${lng}__${acc}`;
}

function safeBaseName(s) {
  return String(s || "photo.jpg")
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function exactBaseName(s) {
  const raw = String(s || "").split(/[\\/]/).pop();
  return String(raw || "").trim();
}

function inferContentTypeFromName(name = "") {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".heif")) return "image/heif";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".mov")) return "video/quicktime";
  return "application/octet-stream";
}

exports.addEvidenceV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    
    // PEAKOPS_BUCKET_FIX_V1
    // Ensure bucket is defined (some paths expect it for Storage existence checks / writes).
    const bucket = String(body.bucket || (body.file && body.file.bucket) || "").trim();
    if (!bucket) throw new Error("bucket required");
const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    const phase = cleanLabel(body.phase || "UNSPEC");
    const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
    const labels = labelsRaw.map(cleanLabel).filter(Boolean).slice(0, 8);

    const gps = normGps(body.gps);
    const notes = String(body.notes || "").trim().slice(0, 500);
    const jobId = String(body.jobId || "").trim();

    // In MVP we store metadata; actual upload can be separate.
    const storagePath = String(body.storagePath || "").trim(); // optional for now

  // PEAKOPS_NO_GHOST_EVIDENCE_V1
  // In emulator, ensure the object exists in Storage before writing Firestore evidence doc.
  // Add a short retry loop to avoid race conditions right after upload.
  const _emuHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const _isEmu =
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!_emuHost;

  if (_isEmu) {
    const host = _emuHost || "127.0.0.1:9199";
    const enc = encodeURIComponent(storagePath);
    const metaUrl = `http://${host}/v0/b/${bucket}/o/${enc}`;

    let ok = false;
    let lastStatus = 0;

    for (let i = 0; i < 12; i++) { // ~2.4s total
      const metaRes = await fetch(metaUrl, { method: "GET" });
      lastStatus = Number(metaRes.status || 0);
      if (metaRes.ok) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!ok) {
      return j(res, 400, { ok: false, error: "object_missing", bucket, storagePath, status: lastStatus });
    }
  }

    const originalName = exactBaseName(body.originalName) || "photo.jpg";
    const exportNameOriginal = safeBaseName(originalName);
    let contentType = normalizeContentType(body.contentType);
    if (!contentType) {
      contentType = inferContentTypeFromName(originalName);
    }
    const bodyBucket = String(body.bucket || "").trim();
    const fileMeta = {
      storagePath: storagePath || null,
      contentType,
      originalName,
      bucket: bodyBucket,
      derivativeBucket: String(body.derivativeBucket || "").trim() || "",
    };
    let resolvedBucket = bodyBucket;
    if (!resolvedBucket) {
      const rb = resolveEvidenceBucket({
        file: fileMeta,
        req,
        env: process.env,
        projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "",
      });
      if (!rb.ok) return j(res, 400, { ok: false, error: "bucket_missing", details: rb.error, checked: rb.checked });
      resolvedBucket = rb.bucket;
    }
    if (!resolvedBucket) return j(res, 400, { ok: false, error: "bucket_missing", details: "resolved bucket empty" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incStatus = String((incSnap.exists ? (incSnap.data() || {}) : {}).status || "").toLowerCase();
    if (incStatus === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed", detail: "Incident is read-only" });
    }
    if (jobId) {
      const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
      const jobSnap = await jobRef.get();
      if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
      const job = jobSnap.data() || {};
      if (String(job.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    }
    const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");

    // Ensure session exists (org-scoped)
    const sesRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);
    let sesSnap = await sesRef.get();
// --- DEV/EMULATOR SAFETY: auto-create missing field session (correct path) ---
    const isEmu =
      String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
      String(process.env.FIREBASE_EMULATOR_HUB || "").length > 0;

    // IMPORTANT: startFieldSessionV1 writes sessions under:
    //   orgs/{orgId}/incidents/{incidentId}/fieldSessions/{sessionId}
    // so the dev auto-create MUST write to the same location.
    if (isEmu && sessionId && !sesSnap.exists) {
      try {
        await sesRef.set(
          {
            orgId,
            incidentId,
            sessionId,
            status: "IN_PROGRESS",
            startedAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
            requestedBy: "dev_autocreate_session_correct_path",
            version: 1,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        // swallow in dev; enforce below
      }
    }

    // Re-check (can't reassign const sesSnap; use a new var)
    const sesSnap2 = sesSnap.exists ? sesSnap : await sesRef.get();
    if (!sesSnap2.exists) return j(res, 404, { ok: false, error: "session not found" });
    const evidenceRef = getEvidenceCollectionRef(db, incidentId).doc();
    const evidenceId = evidenceRef.id;

    const stamp = utcStamp();
    const lblPart = labels.length ? `LBL-${labels.join("-")}` : "LBL-NA";
    const exportName =
      `INC-${incidentId}__SES-${sessionId}__PHASE-${phase}__${lblPart}__UTC-${stamp}__${fmtGps(gps)}__${exportNameOriginal}`;

    const now = FieldValue.serverTimestamp();

    const heicCandidate = isHeicEvidence({
      storagePath,
      contentType,
      originalName,
    });

    const conversionStatus = heicCandidate ? "pending" : "n/a";
    const assignmentFields = jobId
      ? {
          jobId,
          evidence: { jobId },
        }
      : {};

    await evidenceRef.set(
      {
        orgId,
        incidentId,
        evidenceId,
        sessionId,
        phase,
        labels,
        notes,
        gps,
        createdAt: now,
        storedAt: now,
        file: {
          storagePath: storagePath || null,
          contentType,
          originalName,
          filename: originalName,
          bucket: resolvedBucket,
          conversionStatus,
          conversionUpdatedAt: now,
          exportName,
        },
        ...assignmentFields,
        version: 1,
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "EVIDENCE_ADDED", sessionId, refId: evidenceId, gps, actor: "field" });

    // Queue HEIC conversion job for deterministic processing by runConversionJobsV1.
    if (heicCandidate && storagePath) {
      const jobRef = db
        .collection("incidents")
        .doc(String(incidentId))
        .collection("conversion_jobs")
        .doc(String(evidenceId));
      await jobRef.set(
        {
          incidentId,
          evidenceId,
          orgId,
          bucket: resolvedBucket,
          storagePath,
          status: "queued",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          attempts: 0,
        },
        { merge: true }
      );
    }

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      sessionId,
      evidenceId,
      exportName,
      bucket: resolvedBucket,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
