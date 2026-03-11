const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  convertHeicObject,
  buildHeicDonePatch,
  patchEvidenceDocAndVerify,
} = require("./convertHeicOnFinalize");
const { isHeicEvidence } = require("./evidenceHeic");
const {
  finalizeHeicSuccess,
  applyEvidenceConversionState,
  shortErr,
  deriveDerivativePaths,
} = require("./evidenceDerivatives");

if (!admin.apps.length) admin.initializeApp();
const HEIC_PATCH_VERSION = "heic_patch_v2_2026_02_20";
const STORAGE_EMULATOR_DEFAULT_PORT = "9199";

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

async function storageEmulatorUp() {
  if (process.env.FUNCTIONS_EMULATOR !== "true") return { ok: true };
  const hostPort = String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || `127.0.0.1:${STORAGE_EMULATOR_DEFAULT_PORT}`).trim();
  const url = `http://${hostPort}/storage/v1/b`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);
    return { ok: res.status !== 0, url, hostPort, status: res.status };
  } catch (e) {
    return { ok: false, url, hostPort, error: String(e?.message || e) };
  }
}

async function resolveEvidenceDoc({ db, incidentId, orgId = "", evidenceId = "", storagePath = "" }) {
  const { getEvidenceDocRef, getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
  const col = getEvidenceCollectionRef(db, incidentId);
  const oid = String(orgId || "").trim();
  const eid = String(evidenceId || "").trim();
  const sp = String(storagePath || "").trim();

  async function byStoragePath(path) {
    const p = String(path || "").trim();
    if (!p) return { ok: false, error: "not_found_by_storagePath", docs: [] };
    const matches = new Map();
    for (const field of ["file.storagePath", "storagePath", "file.objectName"]) {
      const snap = await col.where(field, "==", p).limit(25).get().catch(() => ({ docs: [] }));
      for (const d of (snap.docs || [])) matches.set(d.ref.path, d);
    }
    let docs = Array.from(matches.values());
    if (oid) docs = docs.filter((d) => String((d.data() || {}).orgId || "").trim() === oid);
    if (!docs.length) return { ok: false, error: "not_found_by_storagePath", docs: [] };
    if (docs.length > 1) return { ok: false, error: "ambiguous_docs", docs };
    return { ok: true, ref: docs[0].ref, snap: docs[0], resolvedBy: "storagePath" };
  }

  if (sp) {
    const out = await byStoragePath(sp);
    if (out.ok || out.error === "ambiguous_docs") return out;
  }
  if (eid) {
    const ref = getEvidenceDocRef(db, incidentId, eid);
    const snap = await ref.get();
    if (snap.exists) {
      const doc = snap.data() || {};
      if (!oid || String(doc.orgId || "").trim() === oid) return { ok: true, ref, snap, resolvedBy: "evidenceId" };
    }
  }
  return { ok: false, error: sp ? "not_found_by_storagePath" : "not_found" };
}

exports.convertEvidenceHeicNowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const includeDebug = process.env.FUNCTIONS_EMULATOR === "true";
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = String(body.orgId || "").trim();
    const incidentId = mustStr(body.incidentId, "incidentId");
    const evidenceId = String(body.evidenceId || "").trim();
    const reqStoragePath = String(body.storagePath || "").trim();
    const forceMarkDone = String(body.forceMarkDone || "").toLowerCase() === "true" || body.forceMarkDone === true;
    if (!evidenceId && !reqStoragePath) return j(res, 400, { ok: false, error: "evidenceId or storagePath required" });
    const db = getFirestore();
    const resolved = await resolveEvidenceDoc({
      db,
      incidentId,
      orgId,
      evidenceId,
      storagePath: reqStoragePath,
    });
    if (!resolved.ok) {
      if (resolved.error === "ambiguous_docs") {
        return j(res, 409, {
          ok: false,
          error: "ambiguous_docs",
          incidentId,
          evidenceId,
          storagePath: reqStoragePath,
          docPaths: (resolved.docs || []).map((d) => d.ref.path),
        });
      }
      return j(res, 404, {
        ok: false,
        error: "evidence not found",
        incidentId,
        evidenceId,
        storagePath: reqStoragePath,
        attemptedPath: `incidents/${incidentId}/evidence_locker/${evidenceId || "(unknown)"}`,
        hint: "Check evidenceId via getEvidenceDebugV1/listEvidenceLocker for this incident",
      });
    }
    const ref = resolved.ref;
    const snap = resolved.snap;

    const doc = snap.data() || {};
    const resolvedEvidenceId = String(doc.evidenceId || ref.id || evidenceId || "").trim();
    if (orgId && String(doc.orgId || "") !== orgId) {
      return j(res, 403, { ok: false, error: "org mismatch", orgId, incidentId, evidenceId });
    }

    const file = (doc.file && typeof doc.file === "object") ? doc.file : {};
    const storagePath = String(reqStoragePath || file.storagePath || "").trim();
    if (!storagePath) return j(res, 400, { ok: false, error: "file.storagePath missing", orgId, incidentId, evidenceId });
    if (!isHeicEvidence(file)) {
      return j(res, 200, { ok: true, skipped: true, reason: "not_heic", orgId, incidentId, evidenceId: resolvedEvidenceId, storagePath });
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
    const storageProbe = await storageEmulatorUp();
    if (!storageProbe.ok) {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: "storage_emulator_down",
      }).catch(() => {});
      return j(res, 200, {
        ok: false,
        error: "storage_emulator_down",
        patchVersion: HEIC_PATCH_VERSION,
        details: storageProbe,
      });
    }
    logger.info("HEIC conversion requested", {
      evidenceId,
      orgId: String(doc.orgId || orgId || ""),
      incidentId,
      storagePath,
      contentType: String(file.contentType || ""),
      state: "processing",
    });
    await applyEvidenceConversionState({
      db: getFirestore(),
      incidentId,
      evidenceId: resolvedEvidenceId,
      storagePath,
      bucket: bucketName,
      status: "processing",
    });

    if (forceMarkDone) {
      const bucket = admin.storage().bucket(bucketName);
      const derived = deriveDerivativePaths({
        bucket: bucketName,
        storagePath,
        originalName: String(file.originalName || ""),
        orgId: String(doc.orgId || orgId || ""),
        incidentId,
        evidenceId: resolvedEvidenceId,
      });
      const previewPath = String(file.previewPath || derived.previewPath || "").trim();
      const thumbPath = String(file.thumbPath || derived.thumbPath || "").trim();
      const [previewExists] = previewPath ? await bucket.file(previewPath).exists() : [false];
      const [thumbExists] = thumbPath ? await bucket.file(thumbPath).exists() : [false];
      if (!previewExists || !thumbExists) {
        await applyEvidenceConversionState({
          db: getFirestore(),
          incidentId,
          evidenceId: resolvedEvidenceId,
          storagePath,
          bucket: bucketName,
          status: "failed",
          error: "force_mark_done_missing_derivatives",
        }).catch(() => {});
        return j(res, 200, {
          ok: false,
          error: "force_mark_done_missing_derivatives",
          patchVersion: HEIC_PATCH_VERSION,
          evidenceDocPath: ref.path,
          previewPath,
          thumbPath,
        });
      }
      const patch = buildHeicDonePatch({
        bucket: bucketName,
        storagePath,
        previewPath,
        thumbPath,
      });
      const verify = await patchEvidenceDocAndVerify({ ref, patch });
      if (!verify?.patched) {
        await applyEvidenceConversionState({
          db: getFirestore(),
          incidentId,
          evidenceId: resolvedEvidenceId,
          storagePath,
          bucket: bucketName,
          status: "failed",
          error: "evidence_patch_verify_failed",
        }).catch(() => {});
        return j(res, 200, {
          ok: false,
          error: "evidence_patch_verify_failed",
          patchVersion: HEIC_PATCH_VERSION,
          evidenceDocPath: verify?.evidenceDocPath || ref.path,
          verify,
        });
      }
      return j(res, 200, {
        ok: true,
        reason: "force_mark_done",
        patchVersion: HEIC_PATCH_VERSION,
        evidenceDocPath: ref.path,
        previewPath,
        thumbPath,
      });
    }

    if (file.previewPath && file.thumbPath) {
      const finalize = await finalizeHeicSuccess({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        bucket: bucketName,
        storagePath,
        previewPath: String(file.previewPath || ""),
        thumbPath: String(file.thumbPath || ""),
      });
      logger.info("HEIC conversion done", {
        evidenceId: resolvedEvidenceId,
        orgId: String(doc.orgId || orgId || ""),
        incidentId,
        storagePath,
        convertedJpgPath: String(file.previewPath || ""),
        thumbnailPath: String(file.thumbPath || ""),
        state: "done",
        applied: !!finalize?.applied,
      });
      const patch = buildHeicDonePatch({
        bucket: bucketName,
        storagePath,
        previewPath: String(file.previewPath || ""),
        thumbPath: String(file.thumbPath || ""),
      });
      const verify = await patchEvidenceDocAndVerify({
        ref,
        patch,
      });
      logger.info("HEIC evidence patch verify", verify);
      if (!verify?.patched) {
        await applyEvidenceConversionState({
          db: getFirestore(),
          incidentId,
          evidenceId: resolvedEvidenceId,
          storagePath,
          bucket: bucketName,
          status: "failed",
          error: "evidence_patch_verify_failed",
        }).catch(() => {});
        const failBody = {
          ok: false,
          error: "evidence_patch_verify_failed",
          patchVersion: HEIC_PATCH_VERSION,
          resolvedBy: resolved.resolvedBy || "",
          evidenceDocPath: verify?.evidenceDocPath || ref.path,
        };
        if (includeDebug) {
          failBody.patchKeys = Object.keys(patch || {});
          failBody.verify = verify;
        }
        return j(res, 200, {
          ...failBody,
        });
      }
      const okBody = {
        ok: true,
        reason: "derivatives_exist",
        patchVersion: HEIC_PATCH_VERSION,
        orgId,
        incidentId,
        evidenceId: resolvedEvidenceId,
        resolvedBy: resolved.resolvedBy || "",
        evidenceDocPath: ref.path,
        previewPath: file.previewPath,
        thumbPath: file.thumbPath,
      };
      if (includeDebug) {
        okBody.patchKeys = Object.keys(patch || {});
        okBody.verify = verify;
      }
      return j(res, 200, okBody);
    }

    const out = await convertHeicObject({
      bucketName,
      objectName: storagePath,
      incidentIdHint: incidentId,
      evidenceIdHint: resolvedEvidenceId,
      originalNameHint: String(file.originalName || ""),
    });
    logger.info("HEIC convertHeicObject output", {
      evidenceId,
      orgId: String(doc.orgId || orgId || ""),
      incidentId,
      bucketName,
      objectName: storagePath,
      outOk: !!out?.ok,
      outPreviewPath: String(out?.previewPath || ""),
      outThumbPath: String(out?.thumbPath || ""),
      outReason: String(out?.reason || ""),
      outError: String(out?.error || ""),
    });
    if (out?.ok && (!String(out?.previewPath || "").trim() || !String(out?.thumbPath || "").trim())) {
      logger.error("HEIC conversion missing outputs", {
        evidenceId: resolvedEvidenceId,
        orgId: String(doc.orgId || orgId || ""),
        incidentId,
        bucketName,
        objectName: storagePath,
        outOk: !!out?.ok,
        outPreviewPath: String(out?.previewPath || ""),
        outThumbPath: String(out?.thumbPath || ""),
        outReason: String(out?.reason || ""),
      });
      return j(res, 500, {
        ok: false,
        error: "conversion_missing_outputs",
        patchVersion: HEIC_PATCH_VERSION,
        source: { bucketName, objectName: storagePath },
        conversionOut: {
          ok: !!out?.ok,
          previewPath: String(out?.previewPath || ""),
          thumbPath: String(out?.thumbPath || ""),
          reason: String(out?.reason || ""),
          error: String(out?.error || ""),
        },
      });
    }
    if (out?.reason === "object_not_found") {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        storagePath,
        bucket: bucketName,
        status: "source_missing",
        error: "object_not_found",
      });
      return j(res, 404, {
        ok: false,
        error: "object_not_found",
        patchVersion: HEIC_PATCH_VERSION,
        resolvedBy: resolved.resolvedBy || "",
        evidenceDocPath: ref.path,
        bucket: out.bucket || bucketName,
        objectName: out.objectName || storagePath,
        hint: "upload did not reach storage",
        orgId,
        incidentId,
        evidenceId: resolvedEvidenceId,
      });
    }
    if (!out?.ok && out?.reason !== "derivatives_exist") {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: shortErr(out || {}),
      });
      return j(res, 200, { ok: false, error: "convert failed", details: out || null, orgId, incidentId, evidenceId: resolvedEvidenceId });
    }
    const previewPath = String(out?.previewPath || "");
    const thumbPath = String(out?.thumbPath || "");
    const finalize = await finalizeHeicSuccess({
      db: getFirestore(),
      incidentId,
      evidenceId: resolvedEvidenceId,
      storagePath,
      bucket: bucketName,
      previewPath,
      thumbPath,
    });
    if (!finalize?.ok) {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: "finalize_missing_paths",
      });
      return j(res, 500, {
        ok: false,
        reason: "finalize_missing_paths",
        incidentId,
        evidenceId: resolvedEvidenceId,
        resolvedBy: resolved.resolvedBy || "",
        evidenceDocPath: ref.path,
        storagePath,
      });
    }
    logger.info("HEIC finalize ready", { incidentId, evidenceId: resolvedEvidenceId, applied: !!finalize?.applied });
    const patch = buildHeicDonePatch({
      bucket: bucketName,
      storagePath,
      previewPath: String(finalize?.previewPath || previewPath || ""),
      thumbPath: String(finalize?.thumbPath || thumbPath || ""),
    });
    const verify = await patchEvidenceDocAndVerify({
      ref,
      patch,
    });
    logger.info("HEIC evidence patch verify", verify);
    if (!verify?.patched) {
      await applyEvidenceConversionState({
        db: getFirestore(),
        incidentId,
        evidenceId: resolvedEvidenceId,
        storagePath,
        bucket: bucketName,
        status: "failed",
        error: "evidence_patch_verify_failed",
      }).catch(() => {});
      const failBody = {
        ok: false,
        error: "evidence_patch_verify_failed",
        patchVersion: HEIC_PATCH_VERSION,
        evidenceDocPath: verify?.evidenceDocPath || ref.path,
        conversionStatus: verify?.conversionStatus || "",
        previewPath: verify?.previewPath || "",
        thumbPath: verify?.thumbPath || "",
        conversionOut: {
          ok: !!out?.ok,
          previewPath: String(out?.previewPath || ""),
          thumbPath: String(out?.thumbPath || ""),
          reason: String(out?.reason || ""),
          error: String(out?.error || ""),
        },
        source: { bucketName, objectName: storagePath },
      };
      if (includeDebug) {
        failBody.patchKeys = Object.keys(patch || {});
        failBody.verify = verify;
      }
      return j(res, 200, failBody);
    }
    logger.info("HEIC conversion done", {
      evidenceId: resolvedEvidenceId,
      orgId: String(doc.orgId || orgId || ""),
      incidentId,
      storagePath,
      convertedJpgPath: String(previewPath || finalize?.previewPath || ""),
      thumbnailPath: String(thumbPath || finalize?.thumbPath || ""),
      state: "done",
      applied: !!finalize?.applied,
      evidenceDocPath: ref.path,
    });

    const okBody = {
      ok: true,
      patchVersion: HEIC_PATCH_VERSION,
      orgId,
      incidentId,
      evidenceId: resolvedEvidenceId,
      resolvedBy: resolved.resolvedBy || "",
      evidenceDocPath: ref.path,
      conversionStatus: "done",
      storagePath,
      bucketName,
      previewPath,
      thumbPath,
      reason: out?.reason || (out?.ok ? "converted" : "derivatives_exist"),
      backfillApplied: !!finalize?.applied,
      conversionOut: {
        ok: !!out?.ok,
        previewPath: String(out?.previewPath || ""),
        thumbPath: String(out?.thumbPath || ""),
        reason: String(out?.reason || ""),
        error: String(out?.error || ""),
      },
      source: { bucketName, objectName: storagePath },
    };
    if (includeDebug) {
      okBody.patchKeys = Object.keys(patch || {});
      okBody.verify = verify;
    }
    return j(res, 200, okBody);
  } catch (e) {
    logger.error("HEIC conversion failed", {
      state: "failed",
      error: String(e?.message || e),
      stack: String(e?.stack || ""),
    });
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
