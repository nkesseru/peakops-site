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

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6.1: this endpoint mints a signed PUT URL that
    // grants Storage write access. From a leakage-surface perspective
    // it's analogous to addEvidenceV1 — anyone who can mint the URL
    // can upload arbitrary content into the org's evidence path.
    // Gate as ROLES_FIELD_WORK (field crews upload photos), denying
    // viewer/ghost. Without this gate any caller with an orgId guess
    // could mint upload credentials.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createEvidenceUploadUrlV1] authz_denied", {
        fn: "createEvidenceUploadUrlV1",
        orgId,
        incidentId,
        sessionId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[createEvidenceUploadUrlV1] authz_ok", {
      fn: "createEvidenceUploadUrlV1",
      orgId,
      incidentId,
      sessionId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Closed operational records are immutable. Reject upload-URL
    // minting before any GCS write so a sealed record cannot accrue
    // orphan objects. Supplemental post-closure context goes through
    // the addendum model (PR 43), not back into the original evidence
    // collection.
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

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    const { base, ext } = splitExt(fileName);
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const finalName = `${base}${ext || ""}`;
    const storagePath =
      `orgs/${orgId}/incidents/${incidentId}/uploads/${sessionId}/${ts}__${finalName}`;

    // PEAKOPS_EVIDENCE_UPLOAD_URL_V2
    // Branch on whether we're running inside the Firebase emulator suite.
    // Emulator: return an unsigned upload-URL against the local Storage
    // emulator (the existing uploadEvidenceProxyV1 handles the odd emulator
    // upload protocol and that endpoint short-circuits outside dev).
    // Production: mint a real v4 signed PUT URL against the real bucket so
    // the browser uploads directly to GCS and NEVER hits uploadEvidenceProxyV1
    // (which returns 403 dev_only_endpoint in prod).
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
      // Real GCS v4 signed PUT URL. Requires the runtime service account to
      // have iam.serviceAccounts.signBlob on itself (see prod-blocker note).
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

    let uploadUrlHost = "";
    try { uploadUrlHost = new URL(uploadUrl).host; } catch {}

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      sessionId,
      bucket,
      storagePath,
      contentType,
      uploadUrl,
      uploadMethod,
      uploadUrlHost,
      expiresAt: new Date(expiresMs).toISOString(),
      storageEmulatorHost: isEmulator ? (emuHost || "127.0.0.1:9199") : "",
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
