require("./_emu_bootstrap");

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getStorage } = require("firebase-admin/storage");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

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

// PEAKOPS_READ_URL_EMU_GATE_V2 (2026-04-24)
// Match the tightened emulator gate used by addEvidenceV1 and
// _emu_bootstrap.js. Previously we also treated
// FIREBASE_STORAGE_EMULATOR_HOST being set as "we're in the emulator", which
// was load-bearing on _emu_bootstrap loading the checked-in env.runtime and
// fired the emulator branch in production — returning
// http://127.0.0.1:9199/download/... as a read URL to the browser and
// breaking every thumbnail on the deployed app. Rely only on the canonical
// emulator flags FUNCTIONS_EMULATOR / FIREBASE_EMULATOR_HUB that the Firebase
// emulator suite sets and the deployed runtime never sets.
function isEmulatorRuntime() {
  return (
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB
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

exports.createEvidenceReadUrlV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "method_not_allowed" });

    // Parse JSON body safely
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const storagePath = mustStr(body.storagePath, "storagePath");
    const expiresSec = Number(body.expiresSec || 900);

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: signed evidence read URLs are the highest-
    // sensitivity read in the system — a non-member with a guessable
    // storagePath could otherwise download photos. Gate runs before
    // any Storage probe or signed-URL generation.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[createEvidenceReadUrlV1] authz_denied", {
        fn: "createEvidenceReadUrlV1",
        orgId,
        incidentId,
        storagePath,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        capability: "read",
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[createEvidenceReadUrlV1] authz_ok", {
      fn: "createEvidenceReadUrlV1",
      orgId,
      incidentId,
      storagePath,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

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

    // PEAKOPS_READ_URL_RESOLVE_V1 (2026-04-24)
    // Previously we signed against `candidates[0]` blindly. `getSignedUrl`
    // happily signs URLs for non-existent objects; the signature is valid but
    // GCS returns 404/403 on fetch, surfaced as a broken <img>. Firebase
    // projects often have both <project>.appspot.com and
    // <project>.firebasestorage.app backed by the same storage; if the
    // evidence doc's recorded bucket drifts from the actual upload target,
    // reads land on a ghost object.
    //
    // Fix: walk candidates, HEAD each (file.exists()), sign against the
    // first bucket where the object actually lives. Returns 404 with a
    // specific error if no candidate matches — which the frontend's
    // terminal-flag logic turns into a deterministic "Unavailable" tile
    // instead of an ambiguous 403.
    let resolvedBucket = "";
    const probed = [];
    for (const cand of candidates) {
      try {
        const [exists] = await getStorage().bucket(cand).file(storagePath).exists();
        probed.push({ bucket: cand, exists: !!exists });
        if (exists) { resolvedBucket = cand; break; }
      } catch (err) {
        probed.push({ bucket: cand, exists: false, error: (err && err.message) ? err.message : String(err) });
      }
    }

    if (!resolvedBucket) {
      return j(res, 404, {
        ok: false,
        error: "object_not_found",
        orgId,
        incidentId,
        storagePath,
        triedBuckets: probed,
      });
    }

    const file = getStorage().bucket(resolvedBucket).file(storagePath);
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + Math.max(60, expiresSec) * 1000,
    });

    // Return the *actually resolved* bucket so the client can update its
    // local reference if it drifted.
    return j(res, 200, { ok: true, orgId, incidentId, bucket: resolvedBucket, storagePath, url });
  } catch (e) {
    return j(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e || "error") });
  }
});
