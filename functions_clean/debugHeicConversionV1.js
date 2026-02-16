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
  toStr,
} = require("./evidenceDerivatives");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function allowDebug(req) {
  if (process.env.NODE_ENV !== "production") return true;
  const key = toStr(process.env.DEBUG_HEIC_KEY);
  if (!key) return false;
  const provided =
    toStr(req.get?.("x-dev-key")) ||
    toStr(req.query?.devKey) ||
    toStr(req.body?.devKey);
  return provided === key;
}

exports.debugHeicConversionV1 = onRequest({ cors: true }, async (req, res) => {
  const report = {
    ok: false,
    inputs: {},
    evidence: {},
    job: {},
    sourceCheck: {},
    conversionResult: null,
    backfillApplied: false,
    finalEvidence: {},
    errors: [],
    selectedEvidenceId: "",
  };

  try {
    if (req.method !== "POST" && req.method !== "GET") {
      report.errors.push("POST or GET required");
      return j(res, 405, report);
    }
    if (!allowDebug(req)) {
      report.errors.push("debug_forbidden");
      return j(res, 403, report);
    }

    const q = req.method === "GET" ? (req.query || {}) : (req.body || {});
    const orgId = toStr(q.orgId);
    const incidentId = toStr(q.incidentId);
    let evidenceId = toStr(q.evidenceId);
    const dryRun = String(q.dryRun || "false").toLowerCase() === "true";
    report.inputs = { orgId, incidentId, evidenceId, dryRun };

    if (!incidentId) {
      report.errors.push("incidentId required");
      return j(res, 200, report);
    }

    const db = getFirestore();
    const { getEvidenceDocRef, getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
    if (!evidenceId) {
      const candidates = await getEvidenceCollectionRef(db, incidentId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();
      const chosen = candidates.docs.find((d) => {
        const ev = d.data() || {};
        if (orgId && toStr(ev.orgId) && toStr(ev.orgId) !== orgId) return false;
        const file = (ev.file && typeof ev.file === "object") ? ev.file : {};
        return isHeicEvidence(file);
      });
      if (!chosen) {
        report.errors.push("no_heic_evidence_found");
        report.evidence.sample = candidates.docs.slice(0, 5).map((d) => {
          const ev = d.data() || {};
          const file = (ev.file && typeof ev.file === "object") ? ev.file : {};
          return {
            id: d.id,
            originalName: toStr(file.originalName || ""),
            contentType: toStr(file.contentType || ""),
            storagePath: toStr(file.storagePath || ""),
          };
        });
        return j(res, 200, report);
      }
      evidenceId = chosen.id;
      report.selectedEvidenceId = evidenceId;
    } else {
      report.selectedEvidenceId = evidenceId;
    }
    report.inputs.evidenceId = evidenceId;

    const evidenceRef = getEvidenceDocRef(db, incidentId, evidenceId);
    const snap = await evidenceRef.get();
    report.evidence.path = `incidents/${incidentId}/evidence_locker/${evidenceId}`;
    report.evidence.exists = snap.exists;
    if (!snap.exists) {
      report.errors.push("evidence_not_found");
      return j(res, 200, report);
    }

    const doc = snap.data() || {};
    const file = (doc.file && typeof doc.file === "object") ? doc.file : {};
    report.evidence.orgId = toStr(doc.orgId || "");
    report.evidence.file = {
      contentType: toStr(file.contentType || ""),
      originalName: toStr(file.originalName || ""),
      storagePath: toStr(file.storagePath || ""),
      bucket: toStr(file.bucket || ""),
      derivativeBucket: toStr(file.derivativeBucket || ""),
      conversionStatus: toStr(file.conversionStatus || ""),
      conversionError: toStr(file.conversionError || ""),
      previewPath: toStr(file.previewPath || ""),
      thumbPath: toStr(file.thumbPath || ""),
    };
    report.evidence.isHeic = isHeicEvidence(file);
    if (orgId && report.evidence.orgId && report.evidence.orgId !== orgId) {
      report.errors.push("org_mismatch");
    }

    const jobRef = db.collection("incidents").doc(incidentId).collection("conversion_jobs").doc(evidenceId);
    const jobSnap = await jobRef.get();
    report.job.path = `incidents/${incidentId}/conversion_jobs/${evidenceId}`;
    report.job.exists = jobSnap.exists;
    if (jobSnap.exists) {
      const jdoc = jobSnap.data() || {};
      report.job.status = toStr(jdoc.status || "");
      report.job.attempts = Number(jdoc.attempts || 0);
      report.job.lastError = toStr(jdoc.error || "");
      report.job.bucket = toStr(jdoc.bucket || "");
      report.job.storagePath = toStr(jdoc.storagePath || "");
    }

    const bucket = toStr(file.bucket || "");
    const objectName = toStr(file.storagePath || "");
    if (!bucket) {
      report.sourceCheck.resolve = { ok: false, error: "bucket_missing", details: "evidence.file.bucket is empty" };
      report.errors.push("bucket_missing");
      return j(res, 200, report);
    }
    report.sourceCheck.resolve = { ok: true, bucket, objectName };
    if (!objectName) {
      report.errors.push("storagePath_missing");
      return j(res, 200, report);
    }

    try {
      const bucketRef = admin.storage().bucket(bucket);
      const [url] = await bucketRef.file(objectName).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 120 * 1000,
      });
      report.sourceCheck.readUrlResult = { ok: true, url };
      const headRes = await fetch(url, { method: "GET" });
      report.sourceCheck.httpStatus = Number(headRes.status || 0);
      report.sourceCheck.sourceExists = headRes.ok;
      if (!headRes.ok) {
        const txt = await headRes.text().catch(() => "");
        report.sourceCheck.error = txt || `HTTP ${headRes.status}`;
      }
    } catch (e) {
      report.sourceCheck.readUrlResult = { ok: false, error: String(e?.message || e) };
      report.sourceCheck.httpStatus = 0;
      report.sourceCheck.sourceExists = false;
    }

    if (!dryRun && report.sourceCheck.sourceExists && report.evidence.isHeic) {
      const converted = await convertHeicObject({
        bucketName: bucket,
        objectName,
        incidentIdHint: incidentId,
        evidenceIdHint: evidenceId,
        originalNameHint: toStr(file.originalName || ""),
      });
      report.conversionResult = converted || null;
      if (converted?.ok || converted?.reason === "derivatives_exist") {
        const previewPath = toStr(converted?.previewPath || "");
        const thumbPath = toStr(converted?.thumbPath || "");
        const backfill = await finalizeHeicSuccess({
          db,
          incidentId,
          evidenceId,
          storagePath: objectName,
          bucket,
          previewPath,
          thumbPath,
        });
        if (!backfill?.ok) {
          await applyEvidenceConversionState({
            db,
            incidentId,
            evidenceId,
            storagePath: objectName,
            bucket,
            status: "failed",
            error: "finalize_missing_paths",
          });
          report.backfillApplied = false;
          report.conversionResult = {
            ...(converted || {}),
            ok: false,
            reason: "finalize_missing_paths",
          };
        } else {
          logger.info("HEIC finalize ready", { incidentId, evidenceId });
          report.backfillApplied = !!backfill?.applied;
          report.conversionResult = {
            ...(converted || {}),
            ok: true,
            previewPath: toStr(backfill?.previewPath || previewPath),
            thumbPath: toStr(backfill?.thumbPath || thumbPath),
          };
        }
      } else if (converted?.reason === "object_not_found") {
        await applyEvidenceConversionState({
          db,
          incidentId,
          evidenceId,
          storagePath: objectName,
          bucket,
          status: "source_missing",
          error: "object_not_found",
        });
      } else {
        await applyEvidenceConversionState({
          db,
          incidentId,
          evidenceId,
          storagePath: objectName,
          bucket,
          status: "failed",
          error: shortErr(converted || {}),
        });
      }
    } else {
      report.conversionResult = {
        ok: false,
        reason: dryRun ? "dry_run" : (!report.sourceCheck.sourceExists ? "object_not_found" : "not_heic"),
      };
    }
    const finalSnap = await evidenceRef.get();
    const finalDoc = finalSnap.data() || {};
    const finalFile = (finalDoc.file && typeof finalDoc.file === "object") ? finalDoc.file : {};
    report.finalEvidence = {
      exists: finalSnap.exists,
      conversionStatus: toStr(finalFile.conversionStatus || ""),
      conversionError: toStr(finalFile.conversionError || ""),
      previewPath: toStr(finalFile.previewPath || finalFile?.derivatives?.preview?.storagePath || ""),
      thumbPath: toStr(finalFile.thumbPath || finalFile?.derivatives?.thumb?.storagePath || ""),
    };

    report.ok = true;
    return j(res, 200, report);
  } catch (e) {
    report.errors.push(String(e?.message || e));
    return j(res, 200, report);
  }
});
