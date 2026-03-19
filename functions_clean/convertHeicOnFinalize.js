const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const sharp = require("sharp");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { resolveEvidenceBucket } = require("./evidenceBucket");
const {
  deriveDerivativePaths,
  backfillEvidenceDerivatives,
  applyEvidenceConversionState,
  shortErr,
} = require("./evidenceDerivatives");
const execFileAsync = promisify(execFile);
const HEIC_PATCH_VERSION = "heic_patch_v2_2026_02_20";

if (!admin.apps.length) admin.initializeApp();

function isHeic(name = "") {
  const n = name.toLowerCase();
  return n.endsWith(".heic") || n.endsWith(".heif");
}

function extractIncidentId(objectName = "") {
  const m = String(objectName).match(/\/incidents\/([^/]+)\//i);
  return m ? m[1] : "";
}

function extractOrgId(objectName = "") {
  const m = String(objectName).match(/^orgs\/([^/]+)\//i);
  return m ? m[1] : "";
}

function buildHeicDonePatch({ bucket = "", storagePath = "", previewPath = "", thumbPath = "" } = {}) {
  const preview = String(previewPath || "").trim();
  const thumb = String(thumbPath || "").trim();
  const resolvedBucket = String(bucket || "").trim();
  const resolvedStoragePath = String(storagePath || "").trim();
  const filePatch = {
    conversionStatus: "done",
    conversionError: FieldValue.delete(),
    conversionUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    previewPath: preview,
    thumbPath: thumb,
    convertedJpgPath: preview,
    thumbnailPath: thumb,
    previewContentType: "image/jpeg",
    thumbContentType: "image/webp",
    derivativeBucket: resolvedBucket,
    previewBucket: resolvedBucket,
    thumbBucket: resolvedBucket,
    derivatives: {
      preview: {
        storagePath: preview,
        contentType: "image/jpeg",
        bucket: resolvedBucket,
      },
      thumb: {
        storagePath: thumb,
        contentType: "image/webp",
        bucket: resolvedBucket,
      },
    },
  };
  if (resolvedBucket) filePatch.bucket = resolvedBucket;
  if (resolvedStoragePath) filePatch.storagePath = resolvedStoragePath;
  return { file: filePatch };
}

async function patchEvidenceDocAndVerify({ ref, patch }) {
  await ref.set(patch, { merge: true });
  const after = await ref.get();
  const data = after.data() || {};
  const file = (data.file && typeof data.file === "object") ? data.file : {};
  const previewPath = String(file.previewPath || "").trim();
  const thumbPath = String(file.thumbPath || "").trim();
  const status = String(file.conversionStatus || "").toLowerCase();
  const out = {
    evidenceDocPath: ref.path,
    // Canonical verify contract used by UI/debug
    patched: !!after.exists && status === "done" && !!previewPath && !!thumbPath,
    conversionStatus: status,
    previewPath,
    thumbPath,
    patchVersion: HEIC_PATCH_VERSION,
  };
  if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.NODE_ENV !== "production") {
    out.fileKeys = Object.keys(file).slice(0, 50);
    out.fileConversionStatus = String(file.conversionStatus || "");
    out.filePreviewPath = String(file.previewPath || "");
    out.fileThumbPath = String(file.thumbPath || "");
    out.fileThumbnailPath = String(file.thumbnailPath || "");
    out.fileConvertedJpgPath = String(file.convertedJpgPath || "");
  }
  return out;
}

async function patchEvidenceDocsByStoragePath({
  db,
  incidentId,
  orgId = "",
  bucket = "",
  storagePath = "",
  previewPath = "",
  thumbPath = "",
}) {
  const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
  const snap = await getEvidenceCollectionRef(db, incidentId)
    .where("file.storagePath", "==", String(storagePath || ""))
    .limit(25)
    .get();
  const refs = snap.docs
    .filter((d) => {
      if (!orgId) return true;
      return String((d.data() || {}).orgId || "") === String(orgId);
    })
    .map((d) => d.ref);
  if (!refs.length) return [];
  const patch = buildHeicDonePatch({ bucket, storagePath, previewPath, thumbPath });
  return Promise.all(refs.map((ref) => patchEvidenceDocAndVerify({ ref, patch })));
}

function toErrorDetails(err) {
  const e = err || {};
  return {
    errMessage: String(e?.message || e || ""),
    errName: String(e?.name || ""),
    errStack: String(e?.stack || ""),
    errCode: String(e?.code || ""),
  };
}

function isHeicDecodeError(details = {}) {
  const s = `${details.errMessage || ""} ${details.errName || ""}`.toLowerCase();
  return /heic|heif|unsupported image format|no decode delegate|heif/.test(s);
}

function isLocalLike() {
  return process.env.NODE_ENV !== "production" || process.env.FUNCTIONS_EMULATOR === "true";
}

async function commandExists(cmd) {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function convertPreviewViaSips(tmpIn, tmpPreview) {
  await execFileAsync("sips", ["-s", "format", "jpeg", tmpIn, "--out", tmpPreview]);
}

async function convertPreviewViaHeifConvert(tmpIn, tmpPreview) {
  await execFileAsync("heif-convert", [tmpIn, tmpPreview]);
}

async function convertHeicObject({
  bucketName,
  objectName,
  incidentIdHint = "",
  evidenceIdHint = "",
  originalNameHint = "",
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
  const derived = deriveDerivativePaths({
    bucket: bucketName,
    storagePath: objectName,
    originalName: originalNameHint,
    orgId: extractOrgId(objectName),
    incidentId,
    evidenceId: evidenceIdHint,
  });
  const previewPath = derived.previewPath;
  const thumbPath = derived.thumbPath;
  const legacyPreviewPath = String(derived.legacyPreviewPath || "").trim();
  const legacyThumbPath = String(derived.legacyThumbPath || "").trim();

  const tmpPreview = path.join(os.tmpdir(), path.basename(previewPath));
  const tmpThumb = path.join(os.tmpdir(), path.basename(thumbPath));

  try {
    let foundPreviewPath = "";
    let foundThumbPath = "";
    const probePairs = [
      { previewPath, thumbPath },
      { previewPath: legacyPreviewPath, thumbPath: legacyThumbPath },
    ].filter((p, idx, arr) => p.previewPath && p.thumbPath && arr.findIndex((x) => x.previewPath === p.previewPath && x.thumbPath === p.thumbPath) === idx);

    for (const pair of probePairs) {
      const [previewExists] = await bucket.file(pair.previewPath).exists();
      const [thumbExists] = await bucket.file(pair.thumbPath).exists();
      if (previewExists && thumbExists) {
        foundPreviewPath = pair.previewPath;
        foundThumbPath = pair.thumbPath;
        break;
      }
    }
    if (foundPreviewPath && foundThumbPath) {
      await backfillEvidenceDerivatives({
        db: getFirestore(),
        incidentId,
        evidenceId: evidenceIdHint,
        storagePath: objectName,
        bucket: bucketName,
        previewPath: foundPreviewPath,
        thumbPath: foundThumbPath,
      });
      return {
        ok: true,
        skipped: true,
        reason: "derivatives_exist",
        incidentId,
        // Always include canonical derivative paths so callers can backfill docs.
        previewPath: foundPreviewPath,
        thumbPath: foundThumbPath,
        bucketName,
        objectName
      };
    }

    await bucket.file(objectName).download({ destination: tmpIn });

    let fallbackUsed = "";
    try {
      await sharp(tmpIn)
        .rotate()
        .jpeg({ quality: 85, mozjpeg: true })
        .toFile(tmpPreview);
    } catch (e) {
      const details = toErrorDetails(e);
      if (!isHeicDecodeError(details)) throw e;

      const allowSips = String(process.env.ALLOW_SIPS_FALLBACK || "") === "1";
      if (allowSips && isLocalLike() && process.platform === "darwin") {
        await convertPreviewViaSips(tmpIn, tmpPreview);
        fallbackUsed = "sips";
      } else if (await commandExists("heif-convert")) {
        await convertPreviewViaHeifConvert(tmpIn, tmpPreview);
        fallbackUsed = "heif-convert";
      } else {
        const err = new Error(`${details.errMessage} | heic decoder unavailable; set ALLOW_SIPS_FALLBACK=1 on macOS dev or install libheif/heif-convert`);
        err.code = details.errCode || "HEIC_DECODE_UNAVAILABLE";
        throw err;
      }
    }

    await sharp(tmpPreview)
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

    await backfillEvidenceDerivatives({
      db: getFirestore(),
      incidentId,
      evidenceId: evidenceIdHint,
      storagePath: objectName,
      bucket: bucketName,
      previewPath,
      thumbPath,
    });

    return { ok: true, incidentId, previewPath, thumbPath, bucketName, objectName, fallbackUsed };
  } catch (e) {
    const details = toErrorDetails(e);
    const msg = details.errMessage;
    if ((e && Number(e.code) === 404) || /No such object/i.test(msg)) {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: evidenceIdHint,
        storagePath: objectName,
        bucket: bucketName,
        status: "source_missing",
        error: "object_not_found",
      }).catch(() => {});
      return {
        ok: false,
        reason: "object_not_found",
        error: "object_not_found",
        ...details,
        bucket: bucketName,
        objectName,
        hint: "upload did not reach storage",
      };
    }
    await applyEvidenceConversionState({
      db: getFirestore(),
      incidentId,
      evidenceId: evidenceIdHint,
      storagePath: objectName,
      bucket: bucketName,
      status: "failed",
      error: shortErr(details),
    }).catch(() => {});
    return {
      ok: false,
      reason: "convert_error",
      error: shortErr(details),
      ...details,
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
      const incidentId = extractIncidentId(objectName);
      if (!incidentId) {
        logger.warn("HEIC skipped: incidentId not derivable from storagePath", {
          storagePath: objectName,
          expectedPattern: "orgs/{orgId}/incidents/{incidentId}/...",
          regex: "/\\/incidents\\/([^/]+)\\//i",
          state: "skipped",
        });
        return;
      }
      const orgId = extractOrgId(objectName);
      if (incidentId) {
        await applyEvidenceConversionState({
          db: getFirestore(),
          incidentId,
          storagePath: objectName,
          bucket: rb.bucket,
          status: "processing",
        }).catch(() => {});
      }
      logger.info("HEIC conversion processing", {
        evidenceId: "",
        orgId,
        incidentId,
        storagePath: objectName,
        contentType: String(obj.contentType || ""),
        state: "processing",
      });
      const out = await convertHeicObject({ bucketName: rb.bucket, objectName });
      if (out?.ok && (!String(out?.previewPath || "").trim() || !String(out?.thumbPath || "").trim())) {
        logger.error("HEIC conversion missing outputs", {
          storagePath: objectName,
          state: "missing_outputs",
          outOk: !!out?.ok,
          outPreviewPath: String(out?.previewPath || ""),
          outThumbPath: String(out?.thumbPath || ""),
          outReason: String(out?.reason || ""),
          outError: String(out?.error || ""),
        });
      }
      if (out?.ok) {
        const postPatchRows = await patchEvidenceDocsByStoragePath({
          db: getFirestore(),
          incidentId,
          orgId,
          bucket: rb.bucket,
          storagePath: objectName,
          previewPath: String(out?.previewPath || ""),
          thumbPath: String(out?.thumbPath || ""),
        });
        if (!postPatchRows.length) {
          logger.error("HEIC post-conversion patch failed: evidence doc not found", {
            incidentId,
            orgId,
            storagePath: objectName,
            convertedJpgPath: String(out?.previewPath || ""),
            thumbnailPath: String(out?.thumbPath || ""),
          });
        } else {
          postPatchRows.forEach((row) => {
            logger.info("HEIC evidence patch verify", row);
          });
        }
        logger.info("HEIC conversion done", {
          evidenceId: String(out?.evidenceId || ""),
          orgId,
          incidentId: String(out?.incidentId || incidentId || ""),
          storagePath: objectName,
          convertedJpgPath: String(out?.previewPath || ""),
          thumbnailPath: String(out?.thumbPath || ""),
          state: "done",
        });
      }
      if (!out?.ok) logger.error("HEIC convert failed", out);

    } catch (e) {
      logger.error("HEIC conversion failed", e);
    }
  }
);

exports.convertHeicObject = convertHeicObject;
exports.patchEvidenceDocsByStoragePath = patchEvidenceDocsByStoragePath;
exports.buildHeicDonePatch = buildHeicDonePatch;
exports.patchEvidenceDocAndVerify = patchEvidenceDocAndVerify;
