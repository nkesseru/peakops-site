require("./_emu_bootstrap");

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");

// Ensure admin initialized once
try {
  if (!admin.apps.length) admin.initializeApp();
} catch (_) {}

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trim(v) {
  return String(v || "").trim();
}

function mustStr(v, name) {
  const s = trim(v);
  if (!s) throw new Error(`${name} required`);
  return s;
}

function isEmulatorRuntime() {
  return (
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!process.env.FIREBASE_STORAGE_EMULATOR_HOST
  );
}

function flipBucketFamily(b) {
  const n = trim(b);
  if (!n) return "";
  if (n.endsWith(".firebasestorage.app")) return n.replace(/\.firebasestorage\.app$/i, ".appspot.com");
  if (n.endsWith(".appspot.com")) return n.replace(/\.appspot\.com$/i, ".firebasestorage.app");
  return "";
}

function projectId() {
  return trim(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "");
}

function buildEmulatorUrl(bucket, storagePath) {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
  // For emulator REST endpoints, encodeURIComponent is correct
  const b = encodeURIComponent(bucket);
  const p = encodeURIComponent(storagePath);
  // Prefer the "download/storage/v1" endpoint (closer to prod behavior)
  return `http://${host}/download/storage/v1/b/${b}/o/${p}?alt=media`;
}

function buildBucketCandidates(requestedBucket, adminDefaultBucket) {
  const out = [];

  const req = trim(requestedBucket);
  if (req) {
    out.push(req);
    const reqFlip = flipBucketFamily(req);
    if (reqFlip) out.push(reqFlip);
  }

  const envA = trim(process.env.FIREBASE_STORAGE_BUCKET || "");
  if (envA) {
    out.push(envA);
    const envAFlip = flipBucketFamily(envA);
    if (envAFlip) out.push(envAFlip);
  }

  const envB = trim(process.env.STORAGE_BUCKET || "");
  if (envB) {
    out.push(envB);
    const envBFlip = flipBucketFamily(envB);
    if (envBFlip) out.push(envBFlip);
  }

  const adm = trim(adminDefaultBucket);
  if (adm) {
    out.push(adm);
    const admFlip = flipBucketFamily(adm);
    if (admFlip) out.push(admFlip);
  }

  const pid = projectId();
  if (pid) {
    out.push(`${pid}.appspot.com`);
    out.push(`${pid}.firebasestorage.app`);
  }

  // De-dupe while preserving order
  return [...new Set(out.filter(Boolean))];
}

exports.createEvidenceReadUrlV1 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "method_not_allowed" });

    // Parse JSON body safely
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const storagePath = mustStr(body.storagePath, "storagePath");
    const expiresSec = Number(body.expiresSec || 900);

    // Determine admin default bucket if possible
    let adminDefaultBucket = "";
    try {
      adminDefaultBucket = getStorage().bucket().name || "";
    } catch (_) {}

    const candidates = buildBucketCandidates(body.bucket, adminDefaultBucket);
    if (!candidates.length) throw new Error("bucket_missing");

    const emulator = isEmulatorRuntime();

    // Emulator path: do NOT sign. Return an emulator URL (UI expects 'url').
    if (emulator) {
      // We’ll return the first candidate; if bucket-family mismatch exists, the caller can retry with the flipped bucket.
      const bucket = candidates[0];
      const url = buildEmulatorUrl(bucket, storagePath);
      return j(res, 200, { ok: true, orgId, incidentId, bucket, storagePath, url, emulator: true });
    }

    // Prod path: signed URL
    const bucket = candidates[0];
    const file = getStorage().bucket(bucket).file(storagePath);
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + Math.max(60, expiresSec) * 1000,
    });

    return j(res, 200, { ok: true, orgId, incidentId, bucket, storagePath, url });
  } catch (e) {
    return j(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e || "error") });
  }
});
