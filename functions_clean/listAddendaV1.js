// PEAKOPS_LIST_ADDENDA_V1 (2026-05-19, PR 44)
//
// Read-only authenticated listing endpoint for the addenda
// subcollection PR 43 started populating. Returns a strict whitelist
// of fields; chain-of-custody internals (raw userAgent, seal-state
// snapshot) stay server-side.
//
// Mirrors the PR 36 listOrgMembersV1 pattern: Bearer required +
// active org member required. No role gate — reading addenda is
// open to any active member (matches the read posture of other
// list endpoints like listJobsV1).

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { extractActorUid } = require("./_actor");
const { assertActorMember, httpStatusFromAuthzError } = require("./_authz");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

function normFileMeta(file) {
  if (!file || typeof file !== "object") return null;
  const bucket = toStr(file.bucket);
  const storagePath = toStr(file.storagePath);
  if (!bucket || !storagePath) return null;
  return {
    bucket,
    storagePath,
    contentType: toStr(file.contentType) || "application/octet-stream",
    originalName: toStr(file.originalName),
    sizeBytes: Number(file.sizeBytes) || null,
  };
}

// GET ?orgId=&incidentId=&limit=
exports.listAddendaV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") {
      return j(res, 405, { ok: false, error: "GET required" });
    }

    const orgId = toStr(req.query.orgId);
    const incidentId = toStr(req.query.incidentId);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    if (!orgId || !incidentId) {
      return j(res, 400, { ok: false, error: "orgId and incidentId required", count: 0, docs: [] });
    }

    // Auth: Bearer + active org member.
    let actorUid = "";
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      await assertActorMember(orgId, actorUid);
    } catch (e) {
      console.warn("[listAddendaV1] authz_denied", {
        fn: "listAddendaV1",
        orgId,
        incidentId,
        uid: actorUid,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
        count: 0,
        docs: [],
      });
    }

    const db = getFirestore();
    const snap = await db
      .collection("incidents")
      .doc(incidentId)
      .collection("addenda")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get()
      .catch(() => null);

    if (!snap || snap.empty) {
      return j(res, 200, { ok: true, orgId, incidentId, count: 0, docs: [] });
    }

    const docs = snap.docs.map((d) => {
      const data = d.data() || {};
      // Strict response whitelist — internal chain-of-custody fields
      // (createdByDevice raw UA, recordSealAtAddendumTime) stay
      // server-side. Future audits can read them directly from
      // Firestore; the UI doesn't need them.
      return {
        addendumId: toStr(data.addendumId) || d.id,
        createdAt: data.createdAt || null,
        createdBy: toStr(data.createdBy) || null,
        reason: toStr(data.reason).toLowerCase() || null,
        note: toStr(data.note),
        file: normFileMeta(data.file),
        relatedJobId: toStr(data.relatedJobId) || null,
      };
    });

    return j(res, 200, { ok: true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e), count: 0, docs: [] });
  }
});
