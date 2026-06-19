// PEAKOPS_LIST_ORG_MEMBERS_V1 (2026-05-18, PR 36)
//
// Read-only authenticated member directory endpoint. Returns the
// minimal identity surface needed by the Summary page's actor
// resolver — uid, displayName (optional), email (optional), role.
//
// Strictly NOT returned: permissions, source, invitedBy, invitedAt,
// joinedAt, createdAt, updatedAt, custom claims. These are internal
// authz / audit fields that have no business reaching the client.
//
// Authorization mirrors listJobsV1: extractActorUid() reads a verified
// Bearer ID token (with a body-fallback path that
// assertActorCanReadOrg closes via the membership-doc check). The
// caller must be an active member of the requested org. Cross-org
// reads are rejected by assertActorCanReadOrg.
//
// Filter rules:
//   - status === "archived"  → excluded (operational records should
//                              not surface archived contributors)
//   - status === "active" or status === undefined → included
//     (the undefined case mirrors _authz.js's "treat missing as
//     active" backwards-compatibility rule for older membership docs)
//
// Why minimal whitelist instead of returning the whole doc:
//   PeakOps member docs carry permissions matrices and provisioning
//   metadata (source, invitedBy) that describe the *internal authz*
//   posture of each member. The Summary UI doesn't need any of that.
//   Returning the whole doc would broaden the attack surface for
//   future schema additions without any product reason.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

// GET ?orgId&limit
exports.listOrgMembersV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") {
      return j(res, 405, { ok: false, error: "GET required" });
    }

    const orgId = toStr(req.query.orgId);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    if (!orgId) {
      return j(res, 400, { ok: false, error: "orgId required", count: 0, docs: [] });
    }

    // Auth: caller must be an active member of the requested org.
    // Same gate as listJobsV1 — no new auth code.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[listOrgMembersV1] authz_denied", {
        fn: "listOrgMembersV1",
        orgId,
        uid: actorUid,
        capability: "read",
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
        count: 0,
        docs: [],
      });
    }
    console.log("[listOrgMembersV1] authz_ok", {
      fn: "listOrgMembersV1",
      orgId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    const db = getFirestore();
    const snap = await db
      .collection("orgs")
      .doc(orgId)
      .collection("members")
      .limit(limit)
      .get();

    const docs = [];
    for (const d of snap.docs) {
      const data = d.data() || {};
      const status = toStr(data.status).toLowerCase();
      // Treat missing status as "active" — mirrors _authz.js policy
      // for pre-Phase-2 membership docs.
      if (status && status !== "active") continue;

      // Explicit whitelist — never widen this without security review.
      docs.push({
        uid: toStr(data.uid) || d.id,
        displayName: toStr(data.displayName) || null,
        email: toStr(data.email) || null,
        role: toStr(data.role).toLowerCase() || null,
      });
    }

    return j(res, 200, { ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e), count: 0, docs: [] });
  }
});
