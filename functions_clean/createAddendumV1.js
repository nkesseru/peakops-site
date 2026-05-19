// PEAKOPS_ADDENDUM_V1 (2026-05-19, PR 43)
//
// Creates a post-closure addendum on a sealed operational record.
//
// Asymmetric gate to evidence upload: this endpoint REQUIRES the
// incident to be closed. Addenda are explicitly post-closure
// supplemental context. Pre-closure context goes through the normal
// evidence + notes flows.
//
// Permissions: any active org member with field-or-above role may
// file an addendum (locked decision: includes field crew). The
// addendum is logged with the verified Bearer-token uid + coarse
// device metadata for chain-of-custody (mirrors PR 40 pattern).
//
// Validation:
//   - reason ∈ { clarification, customer_followup, audit_support, other }
//   - note required (non-empty after trim, max 500 chars)
//   - file optional; when present, must reference a path under the
//     addenda/ subtree (no smuggling into uploads/)
//
// Side effects:
//   - Writes incidents/{incidentId}/addenda/{addendumId}
//   - Emits ADDENDUM_FILED timeline event with actorUid

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { extractActorUid } = require("./_actor");
const { assertActorMember, httpStatusFromAuthzError } = require("./_authz");

if (!admin.apps.length) admin.initializeApp();

const ALLOWED_REASONS = new Set([
  "clarification",
  "customer_followup",
  "audit_support",
  "other",
]);

// Locked decision (PR 43): field-or-above can file addenda. Viewer
// is rejected. ROLES_FIELD_WORK on the deploy branch encodes the
// same set; inlined here so the function compiles on both branches.
const ALLOWED_ROLES = new Set(["owner", "admin", "supervisor", "field"]);

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function derivePlatform(ua) {
  const u = String(ua || "");
  if (!u) return "";
  if (/iPhone|iPad|iPod/i.test(u)) return "iOS";
  if (/Android/i.test(u)) return "Android";
  return "Web";
}

function normFileMeta(file) {
  if (!file || typeof file !== "object") return null;
  const bucket = String(file.bucket || "").trim();
  const storagePath = String(file.storagePath || "").trim();
  const contentType = String(file.contentType || "").trim() || "application/octet-stream";
  const originalName = String(file.originalName || "").trim();
  const sizeBytes = Number(file.sizeBytes || 0);
  if (!bucket || !storagePath) return null;
  // Refuse anything not under the addenda/ subtree — defends against
  // a malformed client smuggling an uploads/ path into the addendum
  // record.
  if (!/\/addenda\//.test(storagePath)) return null;
  return {
    bucket,
    storagePath,
    contentType,
    originalName,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null,
  };
}

exports.createAddendumV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const reasonRaw = String(body.reason || "").trim().toLowerCase();
    const note = String(body.note || "").trim();
    const relatedJobId = String(body.relatedJobId || "").trim() || null;

    // Auth: Bearer ID token + active org membership.
    let actorUid = "";
    let membershipRole = "";
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const { membership } = await assertActorMember(orgId, actorUid);
      membershipRole = String((membership && membership.role) || "").toLowerCase();
    } catch (e) {
      console.warn("[createAddendumV1] authz_denied", {
        fn: "createAddendumV1",
        orgId,
        incidentId,
        uid: actorUid,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }

    // Role gate: per locked PR 43 decision, field-or-above. Viewer
    // rejected. If membership.role is undefined treat as legacy
    // field (matches existing back-compat policy).
    const effectiveRole = membershipRole || "field";
    if (!ALLOWED_ROLES.has(effectiveRole)) {
      return j(res, 403, {
        ok: false,
        error: "permission-denied",
        detail: "Filing an addendum requires field crew or supervisor+ role.",
      });
    }

    // Validation: reason must be in enum, note must be present.
    if (!ALLOWED_REASONS.has(reasonRaw)) {
      return j(res, 400, { ok: false, error: "invalid_reason" });
    }
    if (!note) {
      return j(res, 400, { ok: false, error: "note_required" });
    }
    if (note.length > 500) {
      return j(res, 400, { ok: false, error: "note_too_long" });
    }

    const db = getFirestore();

    // Closed-status gate: ADDENDA require a CLOSED record. This is
    // the inverse of the evidence/notes gates (PR 41). Open records
    // route their context through normal flows.
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) {
      return j(res, 404, { ok: false, error: "incident_not_found" });
    }
    const incData = incSnap.data() || {};
    const incStatus = String(incData.status || "").toLowerCase();
    if (incStatus !== "closed") {
      return j(res, 400, {
        ok: false,
        error: "incident_not_closed",
        detail: "Addenda apply only to closed operational records. Use the normal evidence or notes flow.",
      });
    }
    if (String(incData.orgId || "").trim() !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }

    // Optional file metadata — only valid when persisted file lives
    // under the addenda/ subtree.
    const fileMeta = normFileMeta(body.file);
    if (body.file && !fileMeta) {
      return j(res, 400, { ok: false, error: "invalid_file_reference" });
    }

    // Device metadata (chain-of-custody) — mirrors PR 40 pattern.
    const userAgentRaw = String((req && req.headers && req.headers["user-agent"]) || "").trim();
    const userAgent = userAgentRaw ? userAgentRaw.slice(0, 256) : "";
    const platform = userAgent ? derivePlatform(userAgent) : "";
    const deviceMeta = userAgent ? { userAgent, platform } : null;

    // Snapshot the seal state at filing time. Useful for audit when
    // re-export or addendum re-filing happens.
    const incidentClosedAt = incData.closedAt || null;
    const incidentUpdatedAt = incData.updatedAt || null;
    const packetExportedAt =
      (incData.packetMeta && incData.packetMeta.exportedAt) || null;

    // Allocate the addendum doc reference, write the persisted
    // record, then emit the timeline event.
    const addendumRef = incRef.collection("addenda").doc();
    const addendumId = addendumRef.id;

    const now = FieldValue.serverTimestamp();

    await addendumRef.set(
      {
        addendumId,
        incidentId,
        orgId,
        createdAt: now,
        createdBy: actorUid || null,
        createdByDevice: deviceMeta,
        reason: reasonRaw,
        note,
        file: fileMeta,
        relatedJobId: relatedJobId || null,
        recordSealAtAddendumTime: {
          incidentClosedAt,
          incidentUpdatedAt,
          packetExportedAt,
        },
        version: 1,
      },
      { merge: true }
    );

    try {
      await emitTimelineEvent({
        orgId,
        incidentId,
        type: "ADDENDUM_FILED",
        actor: "supervisor_ui",
        actorUid: actorUid || null,
        refId: addendumId,
        meta: { reason: reasonRaw, addendumId },
      });
    } catch (e) {
      console.warn("[createAddendumV1] timeline_emit_failed", e && e.message);
    }

    return j(res, 200, { ok: true, addendumId });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e && (e.message || e)) });
  }
});
