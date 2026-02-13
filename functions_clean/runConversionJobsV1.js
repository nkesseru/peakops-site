const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { convertHeicObject } = require("./convertHeicOnFinalize");
const { isHeicEvidence } = require("./evidenceHeic");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

function toLimit(v, def = 10, max = 10) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

exports.runConversionJobsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return j(res, 405, { ok: false, error: "POST or GET required" });
    }
    const q = req.method === "GET" ? (req.query || {}) : (req.body || {});
    const incidentId = toStr(q.incidentId);
    const evidenceId = toStr(q.evidenceId);
    const limit = toLimit(q.limit, 10, 10);

    const db = getFirestore();
    const { getEvidenceDocRef, getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
    let jobs = [];
    if (incidentId && evidenceId) {
      const jobRef = db
        .collection("incidents")
        .doc(incidentId)
        .collection("conversion_jobs")
        .doc(evidenceId);
      const evidenceRef = getEvidenceDocRef(db, incidentId, evidenceId);
      const evidenceSnap = await evidenceRef.get();
      if (!evidenceSnap.exists) {
        return j(res, 200, {
          ok: false,
          processed: 0,
          updatedEvidenceId: evidenceId,
          status: "failed",
          reason: "evidence_not_found",
        });
      }
      const ev = evidenceSnap.data() || {};
      const file = (ev.file && typeof ev.file === "object") ? ev.file : {};
      const bucket = toStr(file.bucket || file.derivativeBucket || "");
      const storagePath = toStr(file.storagePath || "");
      if (!bucket || !storagePath) {
        return j(res, 200, {
          ok: false,
          processed: 0,
          updatedEvidenceId: evidenceId,
          status: "failed",
          reason: "missing_bucket_or_storagePath",
        });
      }
      await jobRef.set(
        {
          incidentId,
          evidenceId,
          orgId: toStr(ev.orgId || ""),
          bucket,
          storagePath,
          status: "queued",
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          attempts: Number((await jobRef.get()).data()?.attempts || 0),
        },
        { merge: true }
      );
      jobs = [(await jobRef.get())];
    } else if (incidentId) {
      const candidates = await getEvidenceCollectionRef(db, incidentId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();
      const chosen = candidates.docs.find((d) => {
        const ev = d.data() || {};
        const file = (ev.file && typeof ev.file === "object") ? ev.file : {};
        return isHeicEvidence(file);
      });
      if (!chosen) {
        return j(res, 200, {
          ok: true,
          processed: 0,
          updatedEvidenceId: "",
          status: "none",
          reason: "no_heic_evidence_found",
          done: 0,
          failed: 0,
          skipped: 0,
          jobs: [],
        });
      }
      const chosenEvidenceId = toStr(chosen.id);
      const ev = chosen.data() || {};
      const file = (ev.file && typeof ev.file === "object") ? ev.file : {};
      const bucket = toStr(file.bucket || file.derivativeBucket || "");
      const storagePath = toStr(file.storagePath || "");
      if (!bucket || !storagePath) {
        return j(res, 200, {
          ok: false,
          processed: 0,
          updatedEvidenceId: chosenEvidenceId,
          status: "failed",
          reason: "missing_bucket_or_storagePath",
        });
      }
      const jobRef = db
        .collection("incidents")
        .doc(incidentId)
        .collection("conversion_jobs")
        .doc(chosenEvidenceId);
      await jobRef.set(
        {
          incidentId,
          evidenceId: chosenEvidenceId,
          orgId: toStr(ev.orgId || ""),
          bucket,
          storagePath,
          status: "queued",
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          attempts: Number((await jobRef.get()).data()?.attempts || 0),
        },
        { merge: true }
      );
      jobs = [(await jobRef.get())];
    } else {
      const snap = await db
        .collectionGroup("conversion_jobs")
        .where("status", "==", "queued")
        .limit(limit)
        .get();
      jobs = snap.docs;
    }

    if (!jobs.length) {
      return j(res, 200, { ok: true, processed: 0, done: 0, failed: 0, skipped: 0, jobs: [] });
    }

    const outRows = [];
    let done = 0;
    let failed = 0;
    let skipped = 0;

    for (const jobDoc of jobs) {
      const job = jobDoc.data() || {};
      const iid =
        toStr(job.incidentId) ||
        toStr(jobDoc.ref.parent?.parent?.id) ||
        incidentId;
      const eid = toStr(job.evidenceId) || toStr(jobDoc.id);
      const bucket = toStr(job.bucket);
      const storagePath = toStr(job.storagePath);
      const attempts = Number(job.attempts || 0) + 1;

      if (!iid || !eid || !bucket || !storagePath) {
        await jobDoc.ref.set(
          {
            status: "failed",
            updatedAt: FieldValue.serverTimestamp(),
            attempts,
            error: "missing_job_fields",
          },
          { merge: true }
        );
        failed += 1;
        outRows.push({ incidentId: iid, evidenceId: eid, status: "failed", error: "missing_job_fields" });
        continue;
      }

      const evidenceRef = getEvidenceDocRef(db, iid, eid);
      await jobDoc.ref.set(
        { status: "processing", updatedAt: FieldValue.serverTimestamp(), attempts, startedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      await evidenceRef.set(
        { "file.conversionStatus": "processing", "file.conversionError": FieldValue.delete() },
        { merge: true }
      );

      const converted = await convertHeicObject({
        bucketName: bucket,
        objectName: storagePath,
        incidentIdHint: iid,
      });

      if (converted?.ok) {
        await evidenceRef.set(
          {
            "file.conversionStatus": "ready",
            "file.conversionError": FieldValue.delete(),
            ...(converted.previewPath ? { "file.previewPath": converted.previewPath } : {}),
            ...(converted.thumbPath ? { "file.thumbPath": converted.thumbPath } : {}),
            ...(converted.previewPath ? { "file.previewContentType": "image/jpeg" } : {}),
            ...(converted.thumbPath ? { "file.thumbContentType": "image/webp" } : {}),
            ...(converted.previewPath ? { "file.derivatives.preview.storagePath": converted.previewPath } : {}),
            ...(converted.previewPath ? { "file.derivatives.preview.contentType": "image/jpeg" } : {}),
            ...(converted.thumbPath ? { "file.derivatives.thumb.storagePath": converted.thumbPath } : {}),
            ...(converted.thumbPath ? { "file.derivatives.thumb.contentType": "image/webp" } : {}),
            storedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await jobDoc.ref.set(
          {
            status: "done",
            updatedAt: FieldValue.serverTimestamp(),
            finishedAt: FieldValue.serverTimestamp(),
            result: {
              previewPath: converted.previewPath || "",
              thumbPath: converted.thumbPath || "",
              skipped: !!converted.skipped,
              reason: converted.reason || "",
            },
            error: FieldValue.delete(),
          },
          { merge: true }
        );
        if (converted.skipped) skipped += 1;
        else done += 1;
        outRows.push({ incidentId: iid, evidenceId: eid, status: "done", skipped: !!converted.skipped, reason: converted.reason || "" });
        continue;
      }

      const notFound = converted?.reason === "object_not_found";
      await evidenceRef.set(
        {
          "file.conversionStatus": notFound ? "source_missing" : "failed",
          "file.conversionError": String(converted?.error || converted?.reason || "convert_error"),
          storedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await jobDoc.ref.set(
        {
          status: "failed",
          updatedAt: FieldValue.serverTimestamp(),
          finishedAt: FieldValue.serverTimestamp(),
          error: String(converted?.error || converted?.reason || "convert_error"),
          details: converted || null,
        },
        { merge: true }
      );
      failed += 1;
      outRows.push({ incidentId: iid, evidenceId: eid, status: "failed", reason: converted?.reason || "", error: String(converted?.error || "") });
    }

    return j(res, 200, {
      ok: true,
      processed: jobs.length,
      updatedEvidenceId: outRows[0]?.evidenceId || "",
      status: outRows[0]?.status || "none",
      reason: outRows[0]?.reason || "",
      done,
      failed,
      skipped,
      jobs: outRows,
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
