// PEAKOPS_ACCEPTANCE_READINESS_V1 (PR 103a)
//
// HTTP endpoint that returns the current acceptance readiness for an
// incident. Compute is stateless via _readiness.js; this wrapper
// handles read, computes, persists incident.readinessCache (with
// cachedAt), and returns the projection.
//
// Per the approved PR 103a scope:
//   - Server-only compute (no client mirror)
//   - Cache is a courtesy for fast Records-page reads; the value
//     is recomputed on every call so the cache is never stale
//   - Read access gated to org members (same posture as getIncidentV1)

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  assertActorCanReadOrg,
  httpStatusFromAuthzError,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { computeAcceptanceReadiness } = require("./_readiness");

if (!admin.apps.length) admin.initializeApp();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getAcceptanceReadinessV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET" });

    const orgId = String(req.query?.orgId || "").trim();
    const incidentId = String(req.query?.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });
    }

    // Members-only read. Mirrors getIncidentV1's gate.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[getAcceptanceReadinessV1] authz_denied", {
        fn: "getAcceptanceReadinessV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        code: e && e.code,
      });
      return send(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[getAcceptanceReadinessV1] authz_ok", {
      fn: "getAcceptanceReadinessV1", orgId, incidentId, uid: actorUid, role: actorRole,
    });

    const db = admin.firestore();

    // Resolve incident ref — prefer org-scoped, fall back to legacy
    // top-level. Mirrors the exportIncidentPacketV1 resolution
    // pattern so readiness compute reads the same source-of-truth doc
    // export would read.
    let incRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let incSnap = await incRef.get();
    if (!incSnap.exists) {
      incRef = db.collection("incidents").doc(incidentId);
      incSnap = await incRef.get();
    }
    if (!incSnap.exists) return send(res, 404, { ok: false, error: "incident_not_found" });
    const incident = { id: incSnap.id, ...incSnap.data() };

    // Subcollections live on the legacy top-level path. (Same path
    // alignment as exportIncidentPacketV1 — see comment block there.)
    // PR 108 — also load notes/main so the field-notes evaluator can
    // observe notes written by saveIncidentNotesV1 (which writes to the
    // subdoc, not to incident.incidentNotes). Mirrored in
    // refreshReadinessCache so both writers compute the same cache.
    const legacyIncRef = db.collection("incidents").doc(incidentId);
    const [jobsSnap, evSnap, notesSnap] = await Promise.all([
      legacyIncRef.collection("jobs").get(),
      legacyIncRef.collection("evidence_locker").get(),
      legacyIncRef.collection("notes").doc("main").get(),
    ]);
    const jobs = jobsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const evidence = evSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const notes = notesSnap.exists ? (notesSnap.data() || null) : null;

    const readiness = computeAcceptanceReadiness({ incident, evidence, jobs, notes });

    // Persist a cache copy on the incident doc for fast Records-page
    // reads. cachedAt is the moment of THIS compute; readers can
    // decide their own staleness tolerance.
    const cachePayload = {
      ...readiness,
      cachedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    try {
      await incRef.set({ readinessCache: cachePayload }, { merge: true });
    } catch (e) {
      // Cache write is a courtesy — never block the response on a
      // cache failure. Log and continue.
      console.warn("[getAcceptanceReadinessV1] cache_write_failed", {
        incidentId, error: String(e?.message || e),
      });
    }

    return send(res, 200, { ok: true, orgId, incidentId, readiness });
  } catch (e) {
    console.error("[getAcceptanceReadinessV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
