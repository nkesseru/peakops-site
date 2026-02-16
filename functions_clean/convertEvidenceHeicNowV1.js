const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { convertHeicObject } = require("./convertHeicOnFinalize");
const { isHeicEvidence } = require("./evidenceHeic");
const {
  finalizeHeicSuccess,
  applyEvidenceConversionState,
  shortErr,
} = require("./evidenceDerivatives");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

exports.convertEvidenceHeicNowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = String(body.orgId || "").trim();
    const incidentId = mustStr(body.incidentId, "incidentId");
    const evidenceId = mustStr(body.evidenceId, "evidenceId");

    const { getEvidenceDocRef } = await import("./evidenceRefs.mjs");
    const ref = getEvidenceDocRef(getFirestore(), incidentId, evidenceId);
    const snap = await ref.get();
    if (!snap.exists) {
      return j(res, 404, {
        ok: false,
        error: "evidence not found",
        incidentId,
        evidenceId,
        attemptedPath: `incidents/${incidentId}/evidence_locker/${evidenceId}`,
        hint: "Check evidenceId via getEvidenceDebugV1/listEvidenceLocker for this incident",
      });
    }

    const doc = snap.data() || {};
    if (orgId && String(doc.orgId || "") !== orgId) {
      return j(res, 403, { ok: false, error: "org mismatch", orgId, incidentId, evidenceId });
    }

    const file = (doc.file && typeof doc.file === "object") ? doc.file : {};
    const storagePath = String(file.storagePath || "");
    if (!storagePath) return j(res, 400, { ok: false, error: "file.storagePath missing", orgId, incidentId, evidenceId });
    if (!isHeicEvidence(file)) {
      return j(res, 200, { ok: true, skipped: true, reason: "not_heic", orgId, incidentId, evidenceId, storagePath });
    }
    const bucketName = String(file.bucket || "").trim();
    if (!bucketName) {
      return j(res, 400, {
        ok: false,
        error: "bucket_missing",
        details: "evidence.file.bucket is empty",
        orgId,
        incidentId,
        evidenceId,
      });
    }

    if (file.previewPath && file.thumbPath) {
      const finalize = await finalizeHeicSuccess({
        db: getFirestore(),
        incidentId,
        evidenceId,
        bucket: bucketName,
        storagePath,
        previewPath: String(file.previewPath || ""),
        thumbPath: String(file.thumbPath || ""),
      });
      logger.info("HEIC finalize ready", { incidentId, evidenceId, applied: !!finalize?.applied });
      return j(res, 200, {
        ok: true,
        skipped: true,
        reason: "derivatives_exist",
        orgId,
        incidentId,
        evidenceId,
        previewPath: file.previewPath,
        thumbPath: file.thumbPath,
      });
    }

    const out = await convertHeicObject({
      bucketName,
      objectName: storagePath,
      incidentIdHint: incidentId,
      evidenceIdHint: evidenceId,
      originalNameHint: String(file.originalName || ""),
    });
    if (out?.reason === "object_not_found") {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId,
        storagePath,
        bucket: bucketName,
        status: "source_missing",
        error: "object_not_found",
      });
      return j(res, 404, {
        ok: false,
        error: "object_not_found",
        bucket: out.bucket || bucketName,
        objectName: out.objectName || storagePath,
        hint: "upload did not reach storage",
        orgId,
        incidentId,
        evidenceId,
      });
    }
    if (!out?.ok && out?.reason !== "derivatives_exist") {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: shortErr(out || {}),
      });
      return j(res, 500, { ok: false, error: "convert failed", details: out || null, orgId, incidentId, evidenceId });
    }
    const previewPath = String(out?.previewPath || "");
    const thumbPath = String(out?.thumbPath || "");
    const finalize = await finalizeHeicSuccess({
      db: getFirestore(),
      incidentId,
      evidenceId,
      storagePath,
      bucket: bucketName,
      previewPath,
      thumbPath,
    });
    if (!finalize?.ok) {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: "finalize_missing_paths",
      });
      return j(res, 500, {
        ok: false,
        reason: "finalize_missing_paths",
        incidentId,
        evidenceId,
        storagePath,
      });
    }
    logger.info("HEIC finalize ready", { incidentId, evidenceId, applied: !!finalize?.applied });

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      evidenceId,
      storagePath,
      bucketName,
      previewPath,
      thumbPath,
      reason: out?.reason || (out?.ok ? "converted" : "derivatives_exist"),
      backfillApplied: !!finalize?.applied,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
