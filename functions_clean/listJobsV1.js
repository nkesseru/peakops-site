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

async function getIncidentInfo(db, incidentId) {
  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) throw new Error("incident_not_found");
  const inc = incSnap.data() || {};
  const incOrgId = String(inc.orgId || "").trim();
  return { inc, incOrgId: incOrgId || "" };
}

// GET ?orgId&incidentId&limit
exports.listJobsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    if (!orgId || !incidentId) return j(res, 400, { ok: false, error: "orgId and incidentId required" });

    // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 6: list jobs is members-only. The existing
    // assignedOrgId cross-org filter below remains — it lets a
    // partner org see only jobs explicitly assigned to it. The new
    // gate ensures non-members see nothing at all.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorCanReadOrg(orgId, actorUid);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[listJobsV1] authz_denied", {
        fn: "listJobsV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
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
    console.log("[listJobsV1] authz_ok", {
      fn: "listJobsV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      capability: "read",
    });

    const db = getFirestore();
    const { incOrgId } = await getIncidentInfo(db, incidentId);
    if (!incOrgId) return j(res, 400, { ok: false, error: "incident_org_missing", count: 0, docs: [] });

    // PEAKOPS_LIST_JOBS_AUTH_ALIGN_V1 (2026-04-24)
    // listJobsV1 previously gated on requireOrgMember, which rejected every
    // browser fetch that didn't carry a verified Firebase ID token and fired
    // 403 auth_required on the field overview in production. Sibling list/read
    // endpoints consumed by the same field page (listEvidenceLocker,
    // getIncidentV1, listOrgsV1, getTimelineEventsV1) have no such gate —
    // they rely on the incident's own orgId + downstream per-document checks.
    // Align listJobsV1 with that baseline so the field overview stops
    // dead-ending on a single endpoint. Write-side jobs endpoints (getJobV1,
    // updateJobNotesV1, markJobCompleteV1, exportIncidentArtifactV1, etc.)
    // keep their requireOrgMember checks — production write-auth is unchanged.
    // Cross-org reads still filter by assignedOrgId below so a caller on a
    // different org only sees jobs explicitly assigned to it.

    let q = db
      .collection("incidents")
      .doc(incidentId)
      .collection("jobs")
      .orderBy("createdAt", "desc");
    if (orgId !== incOrgId) {
      q = q.where("assignedOrgId", "==", orgId);
    }
    const snap = await q.limit(limit).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return j(res, 200, { ok: true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e), count: 0, docs: [] });
  }
});
