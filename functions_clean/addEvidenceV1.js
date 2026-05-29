const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { resolveEvidenceBucket } = require("./evidenceBucket");
const { normalizeContentType, isHeicEvidence } = require("./evidenceHeic");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { refreshReadinessCache } = require("./_readiness");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function normGps(gps) {
  if (!gps || typeof gps !== "object") return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const accuracyM = gps.accuracyM == null ? null : Number(gps.accuracyM);
  const source = String(gps.source || "device");
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : null, source };
}

function cleanLabel(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_ -]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 24);
}

function utcStamp() {
  // 20260121T002637Z
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function fmtGps(gps) {
  if (!gps) return "GPS-NA";
  const lat = Number(gps.lat).toFixed(4);
  const lng = Number(gps.lng).toFixed(4);
  const acc = gps.accuracyM == null ? "ACC-NA" : `ACC-${Math.round(Number(gps.accuracyM))}m`;
  return `GPS-${lat}_${lng}__${acc}`;
}

function safeBaseName(s) {
  return String(s || "photo.jpg")
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function exactBaseName(s) {
  const raw = String(s || "").split(/[\\/]/).pop();
  return String(raw || "").trim();
}

function inferContentTypeFromName(name = "") {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".heif")) return "image/heif";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".mov")) return "video/quicktime";
  return "application/octet-stream";
}

exports.addEvidenceV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    
    // PEAKOPS_BUCKET_FIX_V1
    // Ensure bucket is defined (some paths expect it for Storage existence checks / writes).
    const bucket = String(body.bucket || (body.file && body.file.bucket) || "").trim();
    if (!bucket) throw new Error("bucket required");
const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 5: evidence upload is field-or-above. Field
    // crews routinely upload photos as part of capture; viewers are
    // denied. Upgraded from the Slice 2 membership-only gate. Runs
    // before the emulator object-existence probe / any Firestore
    // write so a denied caller never even hits Storage.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[addEvidenceV1] authz_denied", {
        fn: "addEvidenceV1",
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
    console.log("[addEvidenceV1] authz_ok", {
      fn: "addEvidenceV1",
      orgId,
      incidentId,
      sessionId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const phase = cleanLabel(body.phase || "UNSPEC");
    const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
    const labels = labelsRaw.map(cleanLabel).filter(Boolean).slice(0, 8);

    const gps = normGps(body.gps);
    const notes = String(body.notes || "").trim().slice(0, 500);
    const jobId = String(body.jobId || "").trim();

    // PEAKOPS_REQUIREMENT_SLOT_FIELDS_V1 (PR 94a)
    //
    // Optional explicit-intent fields the client passes when the
    // operator clicks an adaptive "Capture: <required item>" button
    // (PR 94b UI). Validates cheaply and persists on the evidence
    // doc only when non-empty so legacy / general-proof uploads
    // continue to land with the existing doc shape unchanged.
    //
    //   requirementKey    : slug derived from requirementLabel
    //                       (e.g., "splice-enclosure-photo").
    //                       Stable for the lifetime of a record
    //                       (labels are snapshotted at create time
    //                       per PR 89a; client-side slugger is
    //                       deterministic).
    //   requirementLabel  : human-readable label verbatim from the
    //                       record's snapshotted requirements list.
    //   requirementSource : which template layer fed the snapshot
    //                       on the parent incident doc — one of
    //                       customer_template | org_template |
    //                       archetype. Anything else is ignored.
    //   requirementIndex  : ordinal in the snapshot's
    //                       requiredProof[] array (≥0). Useful for
    //                       stable ordering when labels collide.
    //
    // NOT enforced. NOT validated against the parent incident's
    // requirements snapshot. The slot tag is operator intent —
    // a hint for future audit / per-slot satisfaction views, not
    // a gate. Tampered or stale slot values just sit on the doc
    // without doing anything.
    const REQUIREMENT_KEY_MAX = 120;
    const REQUIREMENT_LABEL_MAX = 200;
    const REQUIREMENT_SOURCE_ENUM = ["customer_template", "org_template", "archetype"];
    const reqKeyRaw = String(body.requirementKey || "").trim();
    const reqLabelRaw = String(body.requirementLabel || "").trim();
    const reqSrcRaw = String(body.requirementSource || "").trim();
    const reqIdxRaw = body.requirementIndex;
    const requirementKey = reqKeyRaw && /^[a-z0-9-]{1,120}$/.test(reqKeyRaw)
      ? reqKeyRaw.slice(0, REQUIREMENT_KEY_MAX)
      : "";
    const requirementLabel = reqLabelRaw
      ? reqLabelRaw.slice(0, REQUIREMENT_LABEL_MAX)
      : "";
    const requirementSource = REQUIREMENT_SOURCE_ENUM.includes(reqSrcRaw) ? reqSrcRaw : "";
    const requirementIndex =
      reqIdxRaw !== undefined &&
      reqIdxRaw !== null &&
      Number.isFinite(Number(reqIdxRaw)) &&
      Number(reqIdxRaw) >= 0
        ? Math.trunc(Number(reqIdxRaw))
        : null;

    // In MVP we store metadata; actual upload can be separate.
    const storagePath = String(body.storagePath || "").trim(); // optional for now

  // PEAKOPS_NO_GHOST_EVIDENCE_V1
  // In the emulator only, poll the local Storage emulator to ensure the
  // uploaded object exists before writing the Firestore evidence doc (avoids
  // "ghost evidence" when the emulator's object-metadata write is slightly
  // delayed relative to the upload response).
  //
  // PEAKOPS_ADDEVIDENCE_EMU_GATE_V2 (2026-04-24)
  // Tightened the emulator signal: we previously also treated
  // FIREBASE_STORAGE_EMULATOR_HOST being set as "we're in the emulator".
  // That was load-bearing on _emu_bootstrap.js's checked-in env.runtime and
  // fired the emulator probe in production — which then tried to fetch
  // http://127.0.0.1:9199/... from a deployed Cloud Function and failed with
  // undici's generic "fetch failed", surfaced to clients as 400. Rely only
  // on the canonical emulator flags FUNCTIONS_EMULATOR / FIREBASE_EMULATOR_HUB
  // that the Firebase emulator suite sets and the deployed runtime never sets.
  const _emuHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const _isEmu =
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB;

  if (_isEmu) {
    const host = _emuHost || "127.0.0.1:9199";
    const enc = encodeURIComponent(storagePath);
    const metaUrl = `http://${host}/v0/b/${bucket}/o/${enc}`;

    let ok = false;
    let lastStatus = 0;

    for (let i = 0; i < 12; i++) { // ~2.4s total
      const metaRes = await fetch(metaUrl, { method: "GET" });
      lastStatus = Number(metaRes.status || 0);
      if (metaRes.ok) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!ok) {
      return j(res, 400, { ok: false, error: "object_missing", bucket, storagePath, status: lastStatus });
    }
  }

    const originalName = exactBaseName(body.originalName) || "photo.jpg";
    const exportNameOriginal = safeBaseName(originalName);
    let contentType = normalizeContentType(body.contentType);
    if (!contentType) {
      contentType = inferContentTypeFromName(originalName);
    }
    const bodyBucket = String(body.bucket || "").trim();
    const fileMeta = {
      storagePath: storagePath || null,
      contentType,
      originalName,
      bucket: bodyBucket,
      derivativeBucket: String(body.derivativeBucket || "").trim() || "",
    };
    let resolvedBucket = bodyBucket;
    if (!resolvedBucket) {
      const rb = resolveEvidenceBucket({
        file: fileMeta,
        req,
        env: process.env,
        projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "",
      });
      if (!rb.ok) return j(res, 400, { ok: false, error: "bucket_missing", details: rb.error, checked: rb.checked });
      resolvedBucket = rb.bucket;
    }
    if (!resolvedBucket) return j(res, 400, { ok: false, error: "bucket_missing", details: "resolved bucket empty" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incStatus = String((incSnap.exists ? (incSnap.data() || {}) : {}).status || "").toLowerCase();
    if (incStatus === "closed") {
      return j(res, 409, { ok: false, error: "incident_closed", detail: "Incident is read-only" });
    }
    if (jobId) {
      const jobRef = db.collection("incidents").doc(incidentId).collection("jobs").doc(jobId);
      const jobSnap = await jobRef.get();
      if (!jobSnap.exists) return j(res, 404, { ok: false, error: "job_not_found" });
      const job = jobSnap.data() || {};
      if (String(job.orgId || "") !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    }
    const { getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");

    // Ensure session exists (top-level canonical incident path)
    const sesRef = db.collection("incidents")
      .doc(incidentId)
      .collection("fieldSessions")
      .doc(sessionId);
    let sesSnap = await sesRef.get();

    // --- DEV/EMULATOR SAFETY: auto-create missing field session at canonical path ---
    const isEmu =
      String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
      String(process.env.FIREBASE_EMULATOR_HUB || "").length > 0;

    // IMPORTANT: startFieldSessionV1 writes sessions under:
    //   incidents/{incidentId}/fieldSessions/{sessionId}
    // so the dev auto-create MUST write to the same location.
    if (isEmu && sessionId && !sesSnap.exists) {
      try {
        await sesRef.set(
          {
            orgId,
            incidentId,
            sessionId,
            techUserId: String(body.techUserId || "dev_autocreate"),
            status: "IN_PROGRESS",
            startedAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
            requestedBy: "dev_autocreate_session_top_level",
            version: 1,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        // swallow in dev; enforce below
      }
    }

    // Re-check (can't reassign const sesSnap; use a new var)
    const sesSnap2 = sesSnap.exists ? sesSnap : await sesRef.get();
    if (!sesSnap2.exists) return j(res, 404, { ok: false, error: "session not found" });
    const evidenceRef = getEvidenceCollectionRef(db, incidentId).doc();
    const evidenceId = evidenceRef.id;

    const stamp = utcStamp();
    const lblPart = labels.length ? `LBL-${labels.join("-")}` : "LBL-NA";
    const exportName =
      `INC-${incidentId}__SES-${sessionId}__PHASE-${phase}__${lblPart}__UTC-${stamp}__${fmtGps(gps)}__${exportNameOriginal}`;

    const now = FieldValue.serverTimestamp();

    const heicCandidate = isHeicEvidence({
      storagePath,
      contentType,
      originalName,
    });

    const conversionStatus = heicCandidate ? "pending" : "n/a";
    const assignmentFields = jobId
      ? {
          jobId,
          evidence: { jobId },
        }
      : {};

    // PEAKOPS_UPLOADER_IDENTITY_V1 (2026-05-18, PR 40 Phase A)
    // Per-evidence chain-of-custody fields. `actorUid` is already
    // extracted above (line ~106) for the authz gate; we reuse it as
    // the uploaderUid persisted on the doc. Device userAgent +
    // coarse platform are derived from request headers — regex only,
    // no ua-parser dependency. Both nullable so paths that don't
    // carry a Bearer token / UA don't fail loudly.
    const userAgentRaw = String((req && req.headers && req.headers["user-agent"]) || "").trim();
    const userAgent = userAgentRaw ? userAgentRaw.slice(0, 256) : "";
    const derivePlatform = (ua) => {
      const u = String(ua || "");
      if (!u) return "";
      if (/iPhone|iPad|iPod/i.test(u)) return "iOS";
      if (/Android/i.test(u)) return "Android";
      return "Web";
    };
    const platform = userAgent ? derivePlatform(userAgent) : "";
    const deviceMeta = userAgent ? { userAgent, platform } : null;

    // PEAKOPS_REQUIREMENT_SLOT_FIELDS_V1 (PR 94a) — only land the
    // 4 fields when at least one resolved to a usable value. Spread
    // pattern keeps the doc shape minimal for the common general-
    // proof upload (no slot intent).
    const requirementSlotFields = {};
    if (requirementKey)      requirementSlotFields.requirementKey      = requirementKey;
    if (requirementLabel)    requirementSlotFields.requirementLabel    = requirementLabel;
    if (requirementSource)   requirementSlotFields.requirementSource   = requirementSource;
    if (requirementIndex !== null) requirementSlotFields.requirementIndex = requirementIndex;

    await evidenceRef.set(
      {
        orgId,
        incidentId,
        evidenceId,
        sessionId,
        phase,
        labels,
        notes,
        gps,
        createdAt: now,
        storedAt: now,
        uploaderUid: actorUid || null,
        device: deviceMeta,
        file: {
          storagePath: storagePath || null,
          contentType,
          originalName,
          filename: originalName,
          bucket: resolvedBucket,
          conversionStatus,
          conversionUpdatedAt: now,
          exportName,
        },
        ...assignmentFields,
        ...requirementSlotFields,
        version: 1,
      },
      { merge: true }
    );

    // PEAKOPS_TIMELINE_ACTOR_UID_V1 (2026-05-18, PR 40 Phase A)
    // Keep actor: "field" for backwards compatibility. actorUid is
    // the new audit-grade field carrying the verified Bearer-token
    // uid (already extracted above for the authz gate).
    await emitTimelineEvent({
      orgId,
      incidentId,
      type: "EVIDENCE_ADDED",
      sessionId,
      refId: evidenceId,
      gps,
      actor: "field",
      actorUid: actorUid || null,
    });

    // PEAKOPS_READINESS_FRESHNESS_V1 (PR 108) — refresh readinessCache
    // so Records / Summary reflect the new evidence without waiting for
    // a Summary view. Awaited so the cache lands before we return; the
    // helper never throws, so cache failure cannot fail this mutation.
    await refreshReadinessCache({ orgId, incidentId });

    // Queue HEIC conversion job for deterministic processing by runConversionJobsV1.
    if (heicCandidate && storagePath) {
      const jobRef = db
        .collection("incidents")
        .doc(String(incidentId))
        .collection("conversion_jobs")
        .doc(String(evidenceId));
      await jobRef.set(
        {
          incidentId,
          evidenceId,
          orgId,
          bucket: resolvedBucket,
          storagePath,
          status: "queued",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          attempts: 0,
        },
        { merge: true }
      );
    }

    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      sessionId,
      evidenceId,
      exportName,
      bucket: resolvedBucket,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e) });
  }
});
