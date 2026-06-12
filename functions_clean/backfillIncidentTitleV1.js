/**
 * PEAKOPS_BACKFILL_INCIDENT_TITLE_V1 (2026-04-30)
 *
 * One-shot maintenance endpoint. Walks every incident in the org
 * (top-level `incidents/{id}` filtered by orgId, plus the per-org
 * subcollection `orgs/{orgId}/incidents`) and, for any whose
 * `incident.title` is empty, looks up the primary task title and
 * writes it back to `incident.title`.
 *
 * Why bother (since listIncidentsV1 already derives displayTitle on
 * the fly): once `incident.title` is populated, every other
 * surface that already reads incident.title (getIncidentV1, the
 * incident detail header, downstream filing generators) gets the
 * same human-readable label without needing its own derivation
 * logic. listIncidentsV1's task lookup short-circuits, so dashboard
 * latency drops.
 *
 * Safety:
 *   - dryRun=1 (default) reports counts only; no writes.
 *   - dryRun=0 actually writes via merge-set.
 *   - Never overwrites a non-empty `title`.
 *   - Idempotent — re-running is a no-op once filled.
 *
 * Usage:
 *   GET /api/fn/backfillIncidentTitleV1?orgId=<org>&dryRun=1
 *   (then dryRun=0 to commit)
 *
 * Auth: same enforceOrgAndProxy gate as the rest of /api/fn/*.
 */

const { onRequest } = require("firebase-functions/v2/https");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

async function loadPrimaryTaskTitle(db, incidentId) {
  try {
    const snap = await db
      .collection("incidents")
      .doc(String(incidentId || ""))
      .collection("jobs")
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    if (snap.empty) return "";
    let firstTaskTitle = "";
    let activeTaskTitle = "";
    for (const d of snap.docs) {
      const data = d.data() || {};
      const t = String(data.title || "").trim();
      if (!t) continue;
      if (!firstTaskTitle) firstTaskTitle = t;
      const status = String(data.status || "").trim().toLowerCase();
      const isActive = status === "open" || status === "in_progress" || status === "review";
      if (isActive && !activeTaskTitle) activeTaskTitle = t;
    }
    return activeTaskTitle || firstTaskTitle;
  } catch {
    return "";
  }
}

exports.backfillIncidentTitleV1 = onRequest(
  { cors: true, invoker: "public" },
  async (req, res) => {
    const orgId = String(req.query.orgId || "").trim();
    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });

    // PEAKOPS_AUTHZ_ADMIN_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 7.1: title-backfill is admin-only. Bulk write
    // surface — restrict to org owners / admins.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[backfillIncidentTitleV1] authz_denied", {
        fn: "backfillIncidentTitleV1",
        orgId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_ADMIN_ONLY,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[backfillIncidentTitleV1] authz_ok", {
      fn: "backfillIncidentTitleV1",
      orgId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_ADMIN_ONLY,
    });

    const dryRun = String(req.query.dryRun || "1") !== "0";
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const db = getFirestore();

    const seen = new Map(); // id -> { ref, title }

    try {
      const topSnap = await db
        .collection("incidents")
        .where("orgId", "==", orgId)
        .limit(limit)
        .get();
      for (const d of topSnap.docs) {
        if (seen.has(d.id)) continue;
        seen.set(d.id, {
          ref: d.ref,
          title: String((d.data() || {}).title || "").trim(),
          path: "top_level",
        });
      }
    } catch (e) {
      console.warn("[backfillIncidentTitleV1] top-level read failed", String(e?.message || e));
    }
    try {
      const orgSnap = await db
        .collection(`orgs/${orgId}/incidents`)
        .limit(limit)
        .get();
      for (const d of orgSnap.docs) {
        if (seen.has(d.id)) continue;
        seen.set(d.id, {
          ref: d.ref,
          title: String((d.data() || {}).title || "").trim(),
          path: "org_scoped",
        });
      }
    } catch (e) {
      console.warn("[backfillIncidentTitleV1] org-scoped read failed", String(e?.message || e));
    }

    const summary = {
      scanned: seen.size,
      alreadyTitled: 0,
      filled: 0,
      stillEmpty: 0,
      writes: [],
      skipped: [],
    };

    for (const [id, entry] of seen) {
      if (entry.title) {
        summary.alreadyTitled += 1;
        continue;
      }
      const primary = await loadPrimaryTaskTitle(db, id);
      if (!primary) {
        summary.stillEmpty += 1;
        summary.skipped.push({ id, reason: "no_primary_task_title" });
        continue;
      }
      if (dryRun) {
        summary.filled += 1;
        summary.writes.push({ id, path: entry.path, wouldWrite: primary });
        continue;
      }
      try {
        await entry.ref.set({ title: primary }, { merge: true });
        summary.filled += 1;
        summary.writes.push({ id, path: entry.path, wrote: primary });
      } catch (e) {
        summary.skipped.push({ id, reason: "write_failed", error: String(e?.message || e) });
      }
    }

    return j(res, 200, {
      ok: true,
      orgId,
      dryRun,
      ...summary,
    });
  },
);
