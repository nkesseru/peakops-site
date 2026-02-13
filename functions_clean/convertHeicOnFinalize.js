const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const sharp = require("sharp");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { resolveEvidenceBucket } = require("./evidenceBucket");

if (!admin.apps.length) admin.initializeApp();

function isHeic(name = "") {
  const n = name.toLowerCase();
  return n.endsWith(".heic") || n.endsWith(".heif");
}

function toPreviewPath(originalPath) {
  const dir = path.posix.dirname(originalPath);
  const base = path.posix.basename(originalPath).replace(/\.(heic|heif)$/i, "");
  return path.posix.join(dir, `${base}__preview.jpg`);
}

function toThumbPath(originalPath) {
  const dir = path.posix.dirname(originalPath);
  const base = path.posix.basename(originalPath).replace(/\.(heic|heif)$/i, "");
  return path.posix.join(dir, `${base}__thumb.webp`);
}

function extractIncidentId(objectName = "") {
  const m = String(objectName).match(/\/incidents\/([^/]+)\//i);
  return m ? m[1] : "";
}

async function updateEvidenceDerivatives({
  incidentId,
  originalPath,
  previewPath,
  thumbPath,
  bucketName,
}) {
  if (!incidentId) return;
  const db = admin.firestore();
  const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
  const snap = await getEvidenceCollectionRef(db, incidentId)
    .where("file.storagePath", "==", originalPath)
    .limit(10)
    .get();

  if (snap.empty) {
    logger.warn("HEIC converted but no evidence doc matched", { incidentId, originalPath });
    return;
  }

  const patch = {
    storedAt: admin.firestore.FieldValue.serverTimestamp(),
    "file.conversionStatus": "ready",
    "file.conversionError": admin.firestore.FieldValue.delete(),
    "file.derivativeBucket": bucketName,
    "file.previewPath": previewPath,
    "file.previewContentType": "image/jpeg",
    "file.thumbPath": thumbPath,
    "file.thumbContentType": "image/webp",
    "file.derivatives.preview.storagePath": previewPath,
    "file.derivatives.preview.contentType": "image/jpeg",
    "file.derivatives.thumb.storagePath": thumbPath,
    "file.derivatives.thumb.contentType": "image/webp",
  };

  await Promise.all(snap.docs.map((d) => d.ref.set(patch, { merge: true })));
}

async function convertHeicObject({
  bucketName,
  objectName,
  incidentIdHint = "",
}) {
  if (!objectName) return { ok: false, reason: "missing_object" };
  const rb = resolveEvidenceBucket({ file: { bucket: bucketName }, env: process.env });
  if (!rb.ok) return { ok: false, reason: "missing_bucket", error: rb.error, checked: rb.checked };
  bucketName = rb.bucket;
  if (!isHeic(objectName)) return { ok: false, reason: "not_heic" };
  if (
    objectName.toLowerCase().endsWith("__preview.jpg") ||
    objectName.toLowerCase().endsWith("__thumb.webp")
  ) {
    return { ok: false, reason: "already_derivative_object" };
  }

  const bucket = admin.storage().bucket(bucketName);
  const incidentId = incidentIdHint || extractIncidentId(objectName);

  const tmpIn = path.join(os.tmpdir(), path.basename(objectName));
  const previewPath = toPreviewPath(objectName);
  const thumbPath = toThumbPath(objectName);

  const tmpPreview = path.join(os.tmpdir(), path.basename(previewPath));
  const tmpThumb = path.join(os.tmpdir(), path.basename(thumbPath));

  try {
    const [previewExists] = await bucket.file(previewPath).exists();
    const [thumbExists] = await bucket.file(thumbPath).exists();
    if (previewExists && thumbExists) {
      await updateEvidenceDerivatives({
        incidentId,
        originalPath: objectName,
        previewPath,
        thumbPath,
        bucketName,
      });
      return { ok: true, skipped: true, reason: "derivatives_exist", incidentId, previewPath, thumbPath, bucketName, objectName };
    }

    await bucket.file(objectName).download({ destination: tmpIn });

    await sharp(tmpIn)
      .rotate()
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(tmpPreview);

    await sharp(tmpIn)
      .rotate()
      .resize({ width: 480, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(tmpThumb);

    await bucket.upload(tmpPreview, {
      destination: previewPath,
      metadata: { contentType: "image/jpeg" }
    });

    await bucket.upload(tmpThumb, {
      destination: thumbPath,
      metadata: { contentType: "image/webp" }
    });

    await updateEvidenceDerivatives({
      incidentId,
      originalPath: objectName,
      previewPath,
      thumbPath,
      bucketName,
    });

    return { ok: true, incidentId, previewPath, thumbPath, bucketName, objectName };
  } catch (e) {
    const msg = String(e?.message || e || "");
    if ((e && Number(e.code) === 404) || /No such object/i.test(msg)) {
      return {
        ok: false,
        reason: "object_not_found",
        error: "object_not_found",
        bucket: bucketName,
        objectName,
        hint: "upload did not reach storage",
      };
    }
    return {
      ok: false,
      reason: "convert_error",
      error: msg || "convert_error",
      bucket: bucketName,
      objectName,
    };
  } finally {
    await fs.rm(tmpIn, { force: true }).catch(() => {});
    await fs.rm(tmpPreview, { force: true }).catch(() => {});
    await fs.rm(tmpThumb, { force: true }).catch(() => {});
  }
}

exports.convertHeicOnFinalize = onObjectFinalized(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 300
  },
  async (event) => {
    const obj = event.data;
    const bucketName = obj.bucket;
    const objectName = obj.name;

    if (!bucketName || !objectName) return;
    if (!isHeic(objectName)) return;

    if (
      objectName.toLowerCase().endsWith("__preview.jpg") ||
      objectName.toLowerCase().endsWith("__thumb.webp")
    ) {
      return;
    }

    logger.info("HEIC detected", { objectName });

    try {
      const rb = resolveEvidenceBucket({ file: { bucket: bucketName }, env: process.env });
      if (!rb.ok) {
        logger.error("HEIC bucket resolution failed", { objectName, error: rb.error, checked: rb.checked });
        return;
      }
      const out = await convertHeicObject({ bucketName: rb.bucket, objectName });
      if (out?.ok) logger.info("HEIC converted", out);

    } catch (e) {
      logger.error("HEIC conversion failed", e);
    }
  }
);

exports.convertHeicObject = convertHeicObject;
