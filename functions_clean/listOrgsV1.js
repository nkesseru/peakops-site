const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { httpStatusFromAuthzError } = require("./_authz");
const { extractActorUid } = require("./_actor");
const { HttpsError } = require("firebase-functions/v2/https");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function applyCors(req, res) {
  const origin = String(req.get?.("origin") || "");
  const allow = origin || "http://127.0.0.1:3001";
  res.set("Access-Control-Allow-Origin", allow);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-peakops-demo");
  res.set("Access-Control-Allow-Credentials", "true");
}

// PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
// Phase 1 Slice 6 — listOrgsV1 used to return every doc in
// orgs/organizations/tenants regardless of caller. That's a
// cross-tenant directory leak: a non-member could discover every
// real org's id and name. Now: extract the caller's uid, walk the
// candidate collections, and return ONLY those orgs where
// orgs/{orgId}/members/{uid} exists with status="active".
//
// At v1 scale this does N membership lookups for an org-switcher
// dropdown — fine for tens of orgs. Phase 2's
// users/{uid}/memberships/{orgId} denormalization (architecture-doc
// § 3) replaces this with a single subcollection scan. Until then
// this is the safe, fail-closed implementation.
exports.listOrgsV1 = onRequest(async (req, res) => {
  applyCors(req, res);

  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    return res.status(204).send("");
  }
  if (String(req.method || "").toUpperCase() !== "GET") {
    return j(res, 405, { ok: false, error: "GET required" });
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const orgId = String(req.query.orgId || "").trim() || "";

  let actorUid = "";
  try {
    ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
    if (!actorUid) {
      throw new HttpsError("unauthenticated", "[authz] missing uid");
    }
  } catch (e) {
    console.warn("[listOrgsV1] authz_denied", {
      fn: "listOrgsV1",
      uid: actorUid,
      capability: "read",
      code: (e && e.code) || "unauthenticated",
    });
    return j(res, httpStatusFromAuthzError(e), {
      ok: false,
      error: (e && e.code) || "unauthenticated",
      count: 0,
      docs: [],
    });
  }

  const db = getFirestore();
  const collections = ["orgs", "organizations", "tenants"];
  const out = [];
  const seen = new Set();
  let scanned = 0;

  for (const col of collections) {
    const snap = await db.collection(col).limit(limit).get().catch(() => null);
    if (!snap || snap.empty) continue;

    for (const d of snap.docs) {
      const x = d.data() || {};
      const resolvedOrgId = String(x.orgId || x.id || d.id || "").trim();
      if (!resolvedOrgId || seen.has(resolvedOrgId)) continue;
      seen.add(resolvedOrgId);
      scanned += 1;

      // Membership probe — owner/admin/supervisor/field/viewer all
      // qualify. We don't use assertActorCanReadOrg here because we
      // need a non-throwing yes/no answer per candidate; throwing on
      // non-membership and catching N times is wasteful and noisy.
      const memberSnap = await db
        .doc(`orgs/${resolvedOrgId}/members/${actorUid}`)
        .get()
        .catch(() => null);
      if (!memberSnap || !memberSnap.exists) continue;
      const m = memberSnap.data() || {};
      const rawStatus = m.status;
      const status =
        typeof rawStatus === "string" && rawStatus.trim()
          ? rawStatus.trim().toLowerCase()
          : "active";
      if (status !== "active") continue;
      const role = String(m.role || "").trim().toLowerCase();
      if (
        role !== "owner" &&
        role !== "admin" &&
        role !== "supervisor" &&
        role !== "field" &&
        role !== "viewer"
      ) {
        continue;
      }

      out.push({
        id: d.id,
        orgId: resolvedOrgId,
        name: String(x.name || x.displayName || x.orgName || resolvedOrgId),
        source: col,
        role,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  console.log("[listOrgsV1] authz_ok", {
    fn: "listOrgsV1",
    uid: actorUid,
    capability: "read",
    candidatesScanned: scanned,
    orgsReturned: out.length,
  });

  return j(res, 200, { ok: true, orgId, count: out.length, docs: out });
});
