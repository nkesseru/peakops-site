const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function safeBaseName(s) {
  return String(s || "photo.jpg")
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "peakops-pilot";
}

function resolveUploadBucket() {
  const explicit = String(process.env.FIREBASE_STORAGE_BUCKET || "").trim();
  if (explicit) return explicit;
  const legacy = String(process.env.STORAGE_BUCKET || "").trim();
  if (legacy) return legacy;
  const pid = String(projectId() || "").trim();
  if (pid) return `${pid}.firebasestorage.app`;
  return "";
}

function normalizeUploadContentType(v) {
  const ct = String(v || "").trim().toLowerCase();
  if (!ct) return "application/octet-stream";
  if (ct === "image/heic" || ct === "image/heif") return "application/octet-stream";
  return ct;
}

// POST body: { orgId, incidentId, sessionId, originalName, contentType }
exports.createEvidenceUploadUrlV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return j(res, 405, { ok: false, error: "GET or POST required" });
    }

    const body =
      req.method === "GET"
        ? ((req.query && typeof req.query === "object") ? req.query : {})
        : ((typeof req.body === "object" && req.body) ? req.body : {});
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    const originalName = safeBaseName(body.originalName || "photo.jpg");
    const contentType = normalizeUploadContentType(body.contentType);

    // storage path (deterministic + tidy)
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z"); // 20260121T125305Z
    const storagePath = `orgs/${orgId}/incidents/${incidentId}/uploads/${sessionId}/${stamp}__${originalName}`;

    const bucketResolved = resolveUploadBucket();
    if (!bucketResolved) return j(res, 400, { ok: false, error: "bucket_missing", checked: ["env.FIREBASE_STORAGE_BUCKET", "env.STORAGE_BUCKET", "GCLOUD_PROJECT fallback"] });
    const bucket = getStorage().bucket(bucketResolved);
    const file = bucket.file(storagePath);

    // Signed URL for direct upload (PUT)
    const expiresMs = Date.now() + 15 * 60 * 1000; // 15 minutes
    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresMs,
    });
    let uploadHost = "";
    let uploadProtocol = "";
    try {
      const u = new URL(uploadUrl);
      uploadHost = String(u.hostname || "");
      uploadProtocol = String(u.protocol || "");
    } catch {}
    if (uploadProtocol !== "https:" || !/storage\.googleapis\.com$/i.test(uploadHost)) {
      return j(res, 500, {
        ok: false,
        error: "invalid_signed_url",
        details: { uploadProtocol, uploadHost },
      });
    }

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      sessionId,
      bucket: bucket.name,
      storagePath,
      contentType,
      uploadUrl,
      uploadMethod: "PUT",
      uploadUrlHost: uploadHost,
      uploadUrlProtocol: uploadProtocol,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  } catch (e) {
    return j(res, 400, { ok:false, error:String(e?.message || e) });
  }
});
