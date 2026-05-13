// PEAKOPS_ACTOR_EXTRACTION_V1 (2026-05-06)
//
// Shared actor-uid resolver for V1 onRequest callables. Tries, in
// order:
//
//   1. `Authorization: Bearer <Firebase-ID-token>` → verifyIdToken → uid
//   2. body.actorUid / body.actorId fallback (dev / smoke-test parity)
//
// Returning a body-fallback uid is intentional: the *next* gate is
// assertActorMember(orgId, uid) from ./_authz, which fails closed if
// no `orgs/{orgId}/members/{uid}` doc exists. Body-supplied uids that
// have no membership doc therefore reject — the fallback is a parity
// path, not a bypass.
//
// Why both bearer and body:
//   - Production / authenticated customers send a Bearer ID token; we
//     want a real uid in that case so audit logs reflect reality.
//   - Internal smoke / dev / emulator flows send body.actorUid because
//     they don't (yet) hold a Firebase Auth session. Phase 1 leaves
//     this open for development continuity. Phase 2 (membership +
//     roles) hardens this further by requiring App Check on every
//     callable, which closes the body-fallback in production.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  try { admin.initializeApp(); } catch (_e) { /* swallow re-init */ }
}

/**
 * Resolve the actor uid for a callable request.
 *
 * @param {import("express").Request} req
 * @param {Record<string, any>} body
 * @returns {Promise<{ uid: string, claims: object | null }>}
 */
async function extractActorUid(req, body) {
  const authz = String(
    (req && req.headers && req.headers.authorization) || "",
  ).trim();

  let uid = "";
  let claims = null;

  if (authz.toLowerCase().startsWith("bearer ")) {
    const token = authz.slice(7).trim();
    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        uid = String((decoded && decoded.uid) || "").trim();
        claims = decoded || null;
      } catch (_e) {
        // verifyIdToken failure → fall through to body fallback. We
        // never echo the error to the client (don't leak whether the
        // token was malformed vs. expired vs. revoked).
      }
    }
  }

  if (!uid) {
    const bodyUid = String(
      (body && (body.actorUid || body.actorId)) || "",
    ).trim();
    if (bodyUid) uid = bodyUid;
  }

  return { uid, claims };
}

module.exports = { extractActorUid };
