require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

function safeBaseName(s) {
  return String(s || "upload.bin")
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120);
}

function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "peakops-pilot";
}

function isEmulatorRuntime() {
  return (
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!process.env.FIREBASE_STORAGE_EMULATOR_HOST
  );
}

async function resolveUploadBucketForRuntime(explicit) {
  const fromReq = toStr(explicit);
  if (fromReq) return fromReq;

  // prefer env
  const envA = toStr(process.env.FIREBASE_STORAGE_BUCKET);
  if (envA) return envA;

  const envB = toStr(process.env.STORAGE_BUCKET);
  if (envB) return envB;

  // admin default
  try {
    const adminBucket = toStr(getStorage().bucket().name);
    if (adminBucket) return adminBucket;
  } catch (_) {}

  // PEAKOPS_SLICE15_BUCKET_FAMILY_ALIGN_V1 (2026-05-06)
  // Project-id fallback. Previously this returned
  // `${pid}.firebasestorage.app` in the emulator and
  // `${pid}.appspot.com` in production — the only place in the
  // codebase that flipped families based on runtime. Every other
  // layer (evidenceBucket.js canonical resolver, env example,
  // production deploy contract) treats `firebasestorage.app` as
  // canonical, so production uploads were landing in a bucket the
  // resolver-canonical contract didn't agree with. The read path
  // (createEvidenceReadUrlV1.js) walks both families as fallback
  // candidates, which masked the misalignment in practice but left
  // a real "uploads here, reads from there" contract gap.
  //
  // Aligned: both runtimes now produce `firebasestorage.app`. The
  // `isEmulatorRuntime` helper above is no longer consulted by this
  // function but remains because it's used elsewhere in the file.
  const pid = toStr(projectId());
  if (!pid) return "";
  return `${pid}.firebasestorage.app`;
}

function inferContentTypeFromName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".heif")) return "image/heif";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".mov")) return "video/quicktime";
  return "";
}

function resolveUploadContentType({ multipartType, requestType, originalName }) {
  const mt = toStr(multipartType);
  if (mt && mt !== "application/octet-stream") return mt;

  const rt = toStr(requestType);
  if (rt && rt !== "application/octet-stream") return rt;

  const inferred = inferContentTypeFromName(originalName);
  if (inferred) return inferred;

  if (mt) return mt;
  if (rt) return rt;

  return "application/octet-stream";
}

async function probeUploadedObject(bucketName, storagePath) {
  const encBucket = encodeURIComponent(String(bucketName || "").trim());
  const encPath = encodeURIComponent(String(storagePath || "").trim());
  const urlDownload = `http://127.0.0.1:9199/download/storage/v1/b/${encBucket}/o/${encPath}?alt=media`;
  const urlV0 = `http://127.0.0.1:9199/v0/b/${encBucket}/o/${encPath}?alt=media`;

  const probe = async (url) => {
    try {
      const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
      const code = Number(res.status || 0);
      return { ok: code === 200 || code === 206, code, url };
    } catch {
      return { ok: false, code: 0, url };
    }
  };

  const a = await probe(urlDownload);
  if (a.ok) return a;

  const b = await probe(urlV0);
  if (b.ok) return b;

  return { ok: false, code: a.code || b.code || 0, url: urlDownload, altUrl: urlV0, downloadHttp: a.code, v0Http: b.code };
}

function parseMultipart(req) {
  const ct = toStr(req.get("content-type"));
  const m = ct.match(/boundary=([^;]+)/i);
  if (!m) return null;

  const boundaryToken = m[1].replace(/^"|"$/g, "");
  if (!boundaryToken) return null;

  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody || "");
  const bodyStr = raw.toString("latin1");
  const boundary = `--${boundaryToken}`;
  const parts = bodyStr.split(boundary).slice(1, -1);

  const fields = {};
  let fileBuffer = null;
  let fileName = "";
  let fileContentType = "";

  for (const p of parts) {
    const part = p.replace(/^\r\n/, "");
    const splitAt = part.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;

    const header = part.slice(0, splitAt);
    const valueStr = part.slice(splitAt + 4).replace(/\r\n$/, "");

    const nameMatch = header.match(/name="([^"]+)"/i);
    const filenameMatch = header.match(/filename="([^"]*)"/i);
    const partTypeMatch = header.match(/content-type:\s*([^\r\n]+)/i);
    const fieldName = nameMatch ? nameMatch[1] : "";
    if (!fieldName) continue;

    if (filenameMatch) {
      fileName = safeBaseName(filenameMatch[1] || "upload.bin");
      fileContentType = toStr(partTypeMatch ? partTypeMatch[1] : "") || "application/octet-stream";
      fileBuffer = Buffer.from(valueStr, "latin1");
    } else {
      fields[fieldName] = valueStr;
    }
  }

  return { fields, fileBuffer, fileName, fileContentType };
}

exports.uploadEvidenceProxyV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") return j(res, 403, { ok: false, error: "dev_only_endpoint" });
    if (req.method !== "POST" && req.method !== "PUT") return j(res, 405, { ok: false, error: "POST or PUT required" });

    const query = (req.query && typeof req.query === "object") ? req.query : {};
    let body = (req.body && typeof req.body === "object") ? req.body : {};

    let dataBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody || "");
    let fromMultipart = false;

    let fileName = safeBaseName(query.originalName || body.originalName || "upload.bin");
    let requestContentType = toStr(query.contentType || body.contentType);
    let multipartContentType = "";

    const reqCt = toStr(req.get("content-type"));
    if (/multipart\/form-data/i.test(reqCt)) {
      const parsed = parseMultipart(req);
      if (parsed && parsed.fileBuffer && parsed.fileBuffer.length) {
        fromMultipart = true;
        body = { ...body, ...parsed.fields };
        dataBuffer = parsed.fileBuffer;
        fileName = safeBaseName(parsed.fileName || fileName);
        multipartContentType = toStr(parsed.fileContentType);
        requestContentType = toStr(query.contentType || body.contentType || requestContentType);
      } else {
        // fall back to rawBody if present
        if (!dataBuffer || !dataBuffer.length) {
          return j(res, 400, { ok: false, error: "multipart_file_missing" });
        }
      }
    }

    const orgId = toStr(query.orgId || body.orgId);

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7: this endpoint is dev_only_endpoint in
    // production (gated above), but in the emulator it accepts
    // multipart uploads. Anyone hitting it could otherwise write
    // arbitrary content to Storage. Add the FIELD_WORK role gate so
    // viewers/non-members can't proxy uploads even in dev.
    if (orgId) {
      let _actorUid = "";
      let _actorRole = null;
      try {
        ({ uid: _actorUid } = await extractActorUid(req, { ...query, ...body }));
        const gate = await assertActorRole(orgId, _actorUid, ROLES_FIELD_WORK);
        _actorRole = (gate.membership && gate.membership.role) || null;
      } catch (e) {
        console.warn("[uploadEvidenceProxyV1] authz_denied", {
          fn: "uploadEvidenceProxyV1",
          orgId,
          uid: _actorUid,
          role: (e && e.details && e.details.role) || null,
          requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
          code: e && e.code,
        });
        return j(res, httpStatusFromAuthzError(e), {
          ok: false,
          error: (e && e.code) || "permission-denied",
        });
      }
      console.log("[uploadEvidenceProxyV1] authz_ok", {
        fn: "uploadEvidenceProxyV1",
        orgId,
        uid: _actorUid,
        role: _actorRole,
        requiredRoles: ROLES_FIELD_WORK,
      });
    }
    const incidentId = toStr(query.incidentId || body.incidentId);
    const sessionId = toStr(query.sessionId || body.sessionId);
    const storagePath = toStr(query.storagePath || body.storagePath);
    const bucketName = await resolveUploadBucketForRuntime(query.bucket || body.bucket);

    if (!orgId || !incidentId || !sessionId || !storagePath) {
      return j(res, 400, { ok: false, error: "orgId incidentId sessionId storagePath required" });
    }
    if (!bucketName) return j(res, 400, { ok: false, error: "bucket_missing" });
    if (!dataBuffer || !dataBuffer.length) return j(res, 400, { ok: false, error: "file_body_missing" });

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Reject byte upload onto a closed operational record. Mirror of
    // the gate in createEvidenceUploadUrlV1 + addEvidenceV1, closing
    // the orphan-GCS-object failure mode in this dev/proxy path.
    const sealDb = getFirestore();
    const sealIncSnap = await sealDb.collection("incidents").doc(incidentId).get();
    const sealIncStatus = String((sealIncSnap.exists ? (sealIncSnap.data() || {}) : {}).status || "").toLowerCase();
    if (sealIncStatus === "closed") {
      return j(res, 409, {
        ok: false,
        error: "incident_closed",
        detail: "Operational record is sealed — file an addendum to attach supplemental context.",
      });
    }

    const contentType = resolveUploadContentType({
      multipartType: multipartContentType,
      requestType: requestContentType,
      originalName: fileName,
    });

    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(storagePath);

    let probe = { ok: true, code: 0, url: "" };
    let uploadAttempts = 0;

    while (uploadAttempts < 2) {
      uploadAttempts += 1;
      await file.delete({ ignoreNotFound: true }).catch(() => {});
      await file.save(dataBuffer, {
        resumable: false,
        metadata: {
          contentType,
          cacheControl: "private, max-age=60",
          metadata: { originalName: fileName, uploadedVia: "uploadEvidenceProxyV1" },
        },
      });

      if (!isEmulatorRuntime()) break;

      probe = await probeUploadedObject(bucket.name, storagePath);
      if (probe.ok) break;
    }

    if (isEmulatorRuntime() && !probe.ok) {
      return j(res, 400, {
        ok: false,
        error: "upload_probe_failed",
        details: { bucket: bucket.name, storagePath, probe },
      });
    }

    return j(res, 200, {
      ok: true,
      via: "proxy",
      fromMultipart,
      bucket: bucket.name,
      storagePath,
      contentType,
      size: dataBuffer.length,
      uploadAttempts,
      ...(isEmulatorRuntime() ? { probeHttp: probe.code, probeUrl: probe.url } : {}),
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
