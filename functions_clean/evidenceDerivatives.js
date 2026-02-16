const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function toStr(v) {
  return String(v || "").trim();
}

function shortErr(out = {}) {
  return String(
    out.errMessage ||
    out.error ||
    out.reason ||
    out.errName ||
    out.errCode ||
    "convert_error"
  ).slice(0, 240);
}

function isLikelyHeicExt(value = "") {
  return /\.(heic|heif)$/i.test(String(value || "").trim());
}

function deriveDerivativePaths({ bucket = "", storagePath = "", originalName = "" } = {}) {
  const bucketOut = toStr(bucket);
  const storage = toStr(storagePath);
  const original = toStr(originalName);
  const lowerStorage = storage.toLowerCase();
  const hasHeicExt = /\.(heic|heif)$/i.test(storage) || (!storage && isLikelyHeicExt(original));
  let basePath = storage;
  if (/\.(heic|heif)$/i.test(storage)) {
    basePath = storage.replace(/\.(heic|heif)$/i, "");
  } else if (!/\.[a-z0-9]{2,8}$/i.test(storage) && isLikelyHeicExt(original)) {
    basePath = storage;
  }
  const previewPath = basePath ? `${basePath}__preview.jpg` : "";
  const thumbPath = basePath ? `${basePath}__thumb.webp` : "";
  return {
    bucket: bucketOut,
    storagePath: storage,
    originalName: original,
    isHeicCandidate: hasHeicExt || /heic|heif/i.test(lowerStorage) || /heic|heif/i.test(original.toLowerCase()),
    previewPath,
    thumbPath,
  };
}

async function getTargetRefs({ db, incidentId, evidenceId = "", storagePath = "" }) {
  const useDb = db || getFirestore();
  const iid = toStr(incidentId);
  const eid = toStr(evidenceId);
  const sp = toStr(storagePath);
  if (!iid) return [];
  const { getEvidenceDocRef, getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
  if (eid) {
    const ref = getEvidenceDocRef(useDb, iid, eid);
    const snap = await ref.get();
    if (snap.exists) return [ref];
  }
  if (!sp) return [];
  const snap = await getEvidenceCollectionRef(useDb, iid)
    .where("file.storagePath", "==", sp)
    .limit(20)
    .get();
  return snap.docs.map((d) => d.ref);
}

async function applyEvidenceConversionState({
  db,
  incidentId,
  evidenceId = "",
  storagePath = "",
  bucket = "",
  status = "pending",
  error = "",
  previewPath = "",
  thumbPath = "",
}) {
  const refs = await getTargetRefs({ db, incidentId, evidenceId, storagePath });
  if (!refs.length) {
    return { ok: false, applied: false, refs: 0, reason: "evidence_not_found" };
  }
  const b = toStr(bucket);
  const sp = toStr(storagePath);
  const pp = toStr(previewPath);
  const tp = toStr(thumbPath);
  const s = toStr(status).toLowerCase() || "pending";
  const patch = {
    storedAt: FieldValue.serverTimestamp(),
    "file.conversionStatus": s,
    "file.conversionUpdatedAt": FieldValue.serverTimestamp(),
  };
  if (b) patch["file.bucket"] = b;
  if (sp) patch["file.storagePath"] = sp;
  if (s === "ready") {
    patch["file.conversionError"] = FieldValue.delete();
    if (pp) {
      patch["file.previewPath"] = pp;
      patch["file.previewContentType"] = "image/jpeg";
      patch["file.derivatives.preview.storagePath"] = pp;
      patch["file.derivatives.preview.contentType"] = "image/jpeg";
    }
    if (tp) {
      patch["file.thumbPath"] = tp;
      patch["file.thumbContentType"] = "image/webp";
      patch["file.derivatives.thumb.storagePath"] = tp;
      patch["file.derivatives.thumb.contentType"] = "image/webp";
    }
  } else if (s === "failed" || s === "source_missing") {
    patch["file.conversionError"] = toStr(error) || shortErr({ error: s });
  }

  await Promise.all(refs.map((ref) => ref.set(patch, { merge: true })));
  return { ok: true, applied: true, refs: refs.length, status: s };
}

async function backfillEvidenceDerivatives({
  db,
  incidentId,
  evidenceId = "",
  storagePath = "",
  bucket = "",
  previewPath = "",
  thumbPath = "",
}) {
  return applyEvidenceConversionState({
    db,
    incidentId,
    evidenceId,
    storagePath,
    bucket,
    status: "ready",
    previewPath,
    thumbPath,
  });
}

async function finalizeHeicSuccess({
  db,
  incidentId,
  evidenceId = "",
  bucket = "",
  storagePath = "",
  previewPath = "",
  thumbPath = "",
}) {
  const derived = deriveDerivativePaths({
    bucket,
    storagePath,
  });
  const finalPreview = toStr(previewPath) || toStr(derived.previewPath);
  const finalThumb = toStr(thumbPath) || toStr(derived.thumbPath);
  return applyEvidenceConversionState({
    db,
    incidentId,
    evidenceId,
    storagePath,
    bucket,
    status: "ready",
    previewPath: finalPreview,
    thumbPath: finalThumb,
  });
}

module.exports = {
  toStr,
  shortErr,
  deriveDerivativePaths,
  applyEvidenceConversionState,
  backfillEvidenceDerivatives,
  finalizeHeicSuccess,
};
