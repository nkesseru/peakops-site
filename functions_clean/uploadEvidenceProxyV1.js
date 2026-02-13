const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");

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

function resolveUploadBucket(explicit) {
  const fromReq = toStr(explicit);
  if (fromReq) return fromReq;
  const envA = toStr(process.env.FIREBASE_STORAGE_BUCKET);
  if (envA) return envA;
  const envB = toStr(process.env.STORAGE_BUCKET);
  if (envB) return envB;
  const pid = toStr(projectId());
  if (pid) return `${pid}.firebasestorage.app`;
  return "";
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
      continue;
    }
    fields[fieldName] = valueStr;
  }

  return { fields, fileBuffer, fileName, fileContentType };
}

exports.uploadEvidenceProxyV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return j(res, 403, { ok: false, error: "dev_only_endpoint" });
    }
    if (req.method !== "POST" && req.method !== "PUT") {
      return j(res, 405, { ok: false, error: "POST or PUT required" });
    }

    const query = req.query && typeof req.query === "object" ? req.query : {};
    let body = req.body && typeof req.body === "object" ? req.body : {};
    let dataBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody || "");
    let fromMultipart = false;
    let fileName = safeBaseName(query.originalName || body.originalName || "upload.bin");
    let contentType = toStr(query.contentType || body.contentType || req.get("content-type")) || "application/octet-stream";

    const reqCt = toStr(req.get("content-type"));
    if (/multipart\/form-data/i.test(reqCt)) {
      const parsed = parseMultipart(req);
      if (!parsed || !parsed.fileBuffer || !parsed.fileBuffer.length) {
        return j(res, 400, { ok: false, error: "multipart_file_missing" });
      }
      fromMultipart = true;
      body = { ...body, ...parsed.fields };
      dataBuffer = parsed.fileBuffer;
      fileName = safeBaseName(parsed.fileName || fileName);
      contentType = toStr(parsed.fileContentType || contentType) || "application/octet-stream";
    }

    const orgId = toStr(query.orgId || body.orgId);
    const incidentId = toStr(query.incidentId || body.incidentId);
    const sessionId = toStr(query.sessionId || body.sessionId);
    const storagePath = toStr(query.storagePath || body.storagePath);
    const bucketName = resolveUploadBucket(query.bucket || body.bucket);
    if (!orgId || !incidentId || !sessionId || !storagePath) {
      return j(res, 400, { ok: false, error: "orgId incidentId sessionId storagePath required" });
    }
    if (!bucketName) {
      return j(res, 400, { ok: false, error: "bucket_missing" });
    }
    if (!dataBuffer || !dataBuffer.length) {
      return j(res, 400, { ok: false, error: "file_body_missing" });
    }

    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(storagePath);
    await file.save(dataBuffer, {
      resumable: false,
      metadata: {
        contentType: contentType || "application/octet-stream",
        metadata: {
          originalName: fileName,
          uploadedVia: "uploadEvidenceProxyV1",
        },
      },
    });

    return j(res, 200, {
      ok: true,
      via: "proxy",
      fromMultipart,
      bucket: bucket.name,
      storagePath,
      contentType,
      size: dataBuffer.length,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
