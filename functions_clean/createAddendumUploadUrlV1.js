// PEAKOPS_ADDENDUM_UPLOAD_URL_V1 (2026-05-19, PR 43)
//
// Mints a signed PUT URL for addendum file attachments. Same gates as
// createAddendumV1 (Bearer + active org member + closed record +
// field-or-above role) — minting before the closed-status check
// would let a malformed client deposit bytes onto sealed records
// that then can't be referenced by an addendum doc.
//
// Path: orgs/{orgId}/incidents/{incidentId}/addenda/{addendumIdHint}/{ts}__{filename}
//
// addendumIdHint is supplied by the client at upload time and reused
// verbatim when createAddendumV1 commits the doc. The file metadata
// is validated server-side at commit (createAddendumV1 refuses any
// path not under /addenda/).

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore } = require("firebase-admin/firestore");
const { extractActorUid } = require("./_actor");
const { assertActorMember, httpStatusFromAuthzError } = require("./_authz");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const ALLOWED_ROLES = new Set(["owner", "admin", "supervisor", "field"]);

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

exports.createAddendumUploadUrlV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const addendumIdHint = mustStr(body.addendumIdHint, "addendumIdHint");
    const fileName = mustStr(body.fileName, "fileName");
    const contentType = String(body.contentType || "application/octet-stream").trim() || "application/octet-stream";

    // Auth gate: Bearer + active org member.
    let actorUid = "";
    let membershipRole = "";
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const { membership } = await assertActorMember(orgId, actorUid);
      membershipRole = String((membership && membership.role) || "").toLowerCase();
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }

    // Role gate (same as createAddendumV1).
    const effectiveRole = membershipRole || "field";
    if (!ALLOWED_ROLES.has(effectiveRole)) {
      return j(res, 403, {
        ok: false,
        error: "permission-denied",
        detail: "Filing an addendum requires field crew or supervisor+ role.",
      });
    }

    // Closed-status gate. Inverted vs evidence upload: addenda only
    // apply to closed records. Open records → 400.
    const db = getFirestore();
    const incSnap = await db.collection("incidents").doc(incidentId).get();
    if (!incSnap.exists) {
      return j(res, 404, { ok: false, error: "incident_not_found" });
    }
    const incStatus = String((incSnap.data() || {}).status || "").toLowerCase();
    if (incStatus !== "closed") {
      return j(res, 400, {
        ok: false,
        error: "incident_not_closed",
        detail: "Addenda apply only to closed operational records.",
      });
    }

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const finalName = safeFileName(fileName);
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const storagePath =
      `orgs/${orgId}/incidents/${incidentId}/addenda/${safeFileName(addendumIdHint)}/${ts}__${finalName}`;

    const emuHost = String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "").trim();
    const isEmulator =
      !!emuHost ||
      String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";

    const expiresMs = Date.now() + 10 * 60 * 1000; // 10 minutes
    let uploadUrl;
    let uploadMethod;

    if (isEmulator) {
      const host = emuHost || "127.0.0.1:9199";
      uploadUrl = `http://${host}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`;
      uploadMethod = "POST";
    } else {
      const fileRef = bucketObj.file(storagePath);
      const [signed] = await fileRef.getSignedUrl({
        action: "write",
        version: "v4",
        expires: expiresMs,
        contentType,
      });
      uploadUrl = signed;
      uploadMethod = "PUT";
    }

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      addendumIdHint,
      bucket,
      storagePath,
      contentType,
      uploadUrl,
      uploadMethod,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String((e && e.message) || e || "error") });
  }
});
