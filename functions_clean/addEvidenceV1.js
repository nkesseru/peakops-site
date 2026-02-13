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
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    const phase = cleanLabel(body.phase || "UNSPEC");
    const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
    const labels = labelsRaw.map(cleanLabel).filter(Boolean).slice(0, 8);

    const gps = normGps(body.gps);
    const notes = String(body.notes || "").trim().slice(0, 500);

    // In MVP we store metadata; actual upload can be separate.
    const storagePath = String(body.storagePath || "").trim(); // optional for now
    const originalName = safeBaseName(body.originalName || "photo.jpg");
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
    const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");

    // Ensure session exists (org-scoped)
    const sesRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);
    const sesSnap = await sesRef.get();
    if (!sesSnap.exists) return j(res, 404, { ok: false, error: "session not found" });


    const evidenceRef = getEvidenceCollectionRef(db, incidentId).doc();
    const evidenceId = evidenceRef.id;

    const stamp = utcStamp();
    const lblPart = labels.length ? `LBL-${labels.join("-")}` : "LBL-NA";
    const exportName =
      `INC-${incidentId}__SES-${sessionId}__PHASE-${phase}__${lblPart}__UTC-${stamp}__${fmtGps(gps)}__${originalName}`;

    const now = FieldValue.serverTimestamp();

    const heicCandidate = isHeicEvidence({
      storagePath,
      contentType,
      originalName,
    });

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
          conversionStatus: heicCandidate ? "pending" : "n/a",
          exportName,
        },
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
