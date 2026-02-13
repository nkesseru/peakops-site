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

exports.createEvidenceReadUrlV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return j(res, 405, { ok: false, error: "GET or POST required" });
    }

    const b =
      req.method === "GET"
        ? ((req.query && typeof req.query === "object") ? req.query : {})
        : ((req.body && typeof req.body === "object") ? req.body : {});

    const orgId = mustStr(b.orgId, "orgId");
    const incidentId = mustStr(b.incidentId, "incidentId");
    const storagePath = mustStr(b.storagePath, "storagePath");

    // optional overrides
    const bucketName = String(b.bucket || "").trim() || process.env.FIREBASE_STORAGE_BUCKET || "";
    const expiresSec = Number(b.expiresSec || 900);

    // If bucket isn't provided, try to infer from storage path usage in your system.
    // In your project, uploads go to the evidence bucket; default bucket may be wrong.
    // So allow passing bucket explicitly from UI response.
    const bucket = bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();

    const file = bucket.file(storagePath);

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresSec * 1000,
    });

    return j(res, 200, { ok: true, orgId, incidentId, storagePath, bucket: bucket.name, url, expiresSec });
  } catch (e) {
    console.error("createEvidenceReadUrlV1 error", e);
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
