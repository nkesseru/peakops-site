require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}
function safeFileName(name) {
  return String(name || "file")
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 160) || "file";
}
function splitExt(name) {
  const n = safeFileName(name);
  const m = n.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
  if (!m) return { base: n, ext: "" };
  return { base: m[1] || n, ext: m[2] || "" };
}

exports.createEvidenceUploadUrlV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");
    const fileName = mustStr(body.fileName, "fileName");
    const contentType = String(body.contentType || "application/octet-stream").trim() || "application/octet-stream";

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const { base, ext } = splitExt(fileName);
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const finalName = `${base}${ext || ""}`;
    const storagePath =
      `orgs/${orgId}/incidents/${incidentId}/uploads/${sessionId}/${ts}__${finalName}`;

    const host = String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199");
    const uploadUrl = `http://${host}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`;

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      sessionId,
      bucket,
      storagePath,
      contentType,
      uploadUrl,
      uploadMethod: "POST",
      uploadUrlHost: host,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      storageEmulatorHost: host,
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
