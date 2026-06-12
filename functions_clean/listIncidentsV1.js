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

// PEAKOPS_LIST_INCIDENTS_DUAL_READ_V1 (2026-04-29)
// Read both the top-level `incidents` collection (the canonical path
// used by getIncidentV1's fallback, listJobsV1, closeIncidentV1,
// saveIncidentNotesV1, createJobV1, approveAndLockJobV1, etc. — where
// the bulk of org data actually lives) AND the per-org subcollection
// `orgs/{orgId}/incidents` (where Mission-Control-created records
// land via createIncidentV1). Merge by doc id, dedupe, sort by
// updatedAt desc client-side. Each branch is wrapped in try/catch
// so a missing collection / missing index in one path doesn't take
// the whole response down.

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

// PEAKOPS_LIST_INCIDENTS_DASHBOARD_FIELDS_V2 (2026-04-30)
// Mission Control needs the same title source the incident detail
// page (getIncidentV1 → IncidentClient) uses, plus a richer set of
// fields for the dashboard rows. Title resolution mirrors
// displayIncidentTitle's frontend chain in Firestore so an empty
// title field doesn't cause every row to display "Untitled
// incident": title → name → displayName → summary → description.
//
// PR 116 — evidenceCount is now a LIVE Firestore aggregation per row
// (Promise.all over the merged list), NOT a packetMeta projection.
// The original "no N+1" stance was correct for full-doc subcollection
// reads, but it made Records and Summary disagree on draft records
// (Records showed "— evidence", Summary showed live count). Firestore
// count() aggregation is a single integer round-trip per row, billed
// as 1 read per 1000 docs counted — cheap, parallelizable, and the
// only way to make every operational surface (Records, Summary,
// IncidentClient, getJobV1, workflowV1) agree on one evidence count.
// Task-state counts (taskCount, approvedTaskCount, completedTaskCount)
// still come from packetMeta; revisit if a similar divergence is
// reported.
function mapDoc(d, fallbackOrgId) {
  const data = d.data() || {};
  const out = {
    id: d.id,
    incidentId: d.id,
    orgId: String(data.orgId || fallbackOrgId),
    title: String(
      data.title ||
      data.name ||
      data.displayName ||
      data.summary ||
      ""
    ).trim(),
    status: String(data.status || "open"),
    createdAt: tsIso(data.createdAt),
    updatedAt: tsIso(data.updatedAt),
  };
  // Always include name/description as additive fields so the
  // frontend's displayIncidentTitle fallback chain has them when
  // title was set under an alternate field name.
  const name = String(data.name || "").trim();
  if (name) out.name = name;
  const description = String(data.description || "").trim();
  if (description) out.description = description;
  // Lifecycle timestamps the dashboard might want to surface.
  const submittedAt = tsIso(data.submittedAt);
  if (submittedAt) out.submittedAt = submittedAt;
  const closedAt = tsIso(data.closedAt);
  if (closedAt) out.closedAt = closedAt;
  // Location / site (legacy field name was `site`).
  const location = String(data.location || data.site || "").trim();
  if (location) out.location = location;
  const priority = String(data.priority || "").trim().toLowerCase();
  if (priority) out.priority = priority;
  // PEAKOPS_LIST_INCIDENTS_CUSTOMER_FIELD_V1 (PR 77a)
  // Surface the customer / agency / project label so the /records
  // index can render it on each card. customer is the canonical
  // field name (PR 68b createIncidentV1 + PR 70 proof-workflow
  // form). customerName is accepted as a legacy fallback for older
  // records that may have stored the value under that name.
  // Omitted from the response when empty so the frontend's
  // "render only when present" rule applies cleanly.
  const customer = String(data.customer || data.customerName || "").trim();
  if (customer) out.customer = customer;
  // PEAKOPS_LIST_INCIDENTS_ARCHETYPE_FIELD_V1 (PR 83a)
  // Surface the proof-workflow archetype (PR 68b createIncidentV1
  // + PR 81a enum extension) so the /records index (PR 83b) can
  // render it as a small eyebrow above the card title. Identical
  // shape to the customer field above — present when non-empty,
  // omitted otherwise. The frontend handles legacy enum values
  // (splice_work, site_survey, cable_install) by simply not
  // rendering an eyebrow for keys outside the curated set.
  const archetype = String(data.archetype || "").trim();
  if (archetype) out.archetype = archetype;
  // PEAKOPS_LIST_INCIDENTS_LIVE_EVIDENCE_COUNT_V1 (PR 116)
  // PacketMeta-cached counts for task/approval state. evidenceCount
  // was removed from this projection in PR 116 — Records cards
  // diverged from Summary on pre-packet records because packetMeta
  // is only written at packet-generation time. The live count via
  // Firestore aggregation now backs Records (see post-mapping block
  // below). Task-state counts stay here for now; revisit if a
  // similar divergence is reported.
  const pm = data.packetMeta || null;
  if (pm && typeof pm === "object") {
    const taskCount = Number(pm.jobCount);
    const approvedCount = Number(pm.approvedJobCount);
    const completedCount = Number(pm.completedJobCount);
    if (Number.isFinite(taskCount) && taskCount >= 0) out.taskCount = taskCount;
    if (Number.isFinite(approvedCount) && approvedCount >= 0) out.approvedTaskCount = approvedCount;
    if (Number.isFinite(completedCount) && completedCount >= 0) out.completedTaskCount = completedCount;
    // packetReady/reportReady — same gate the IncidentClient + Summary
    // page use to decide whether the report is downloadable.
    const packetReady =
      String(pm.status || "").toLowerCase() === "ready" ||
      !!String(pm.downloadUrl || "").trim() ||
      !!String(pm.packetHash || pm.zipSha256 || "").trim() ||
      (!!String(pm.bucket || "").trim() && !!String(pm.storagePath || "").trim());
    if (packetReady) {
      out.packetReady = true;
      out.reportReady = true;
    }
  }

  // PEAKOPS_LIST_INCIDENTS_READINESS_CACHE_V1 (PR 105)
  // PEAKOPS_LIST_INCIDENTS_READINESS_EXPLANATIONS_V1 (PR 107a)
  //
  // Pass through the cached acceptance-readiness state so /records
  // cards can render a small pill without recomputing client-side.
  //
  // The cache (incident.readinessCache) is written by:
  //   - getAcceptanceReadinessV1 (PR 103a) on every call
  //   - exportIncidentPacketV1 (PR 103a) on every packet export
  //   - createIncidentV1 (PR 106) on creation, so brand-new records
  //     get a pill immediately
  // Either function writes the full readiness projection to whichever
  // incident path it resolves (org-scoped preferred, legacy fallback).
  //
  // PR 105 projected only `state`. PR 107a extends the projection to
  // include `missingCount` + `missingItemsPreview` (first 3 missing
  // required-tier labels) so the Records card can render a one-line
  // explanation under the pill — operator sees WHAT is missing without
  // clicking through to Summary. Pure projection at list time; the
  // cache schema is unchanged, no compute helper changes needed.
  //
  // What's projected (intentionally minimal):
  //   {
  //     state,
  //     missingCount?,            // only when state === "requirements_missing"
  //     missingItemsPreview?,     // ditto; up to 3 labels in declared order
  //   }
  // The full cache (full checks[], summary counters, generatedAt, etc.)
  // stays in Firestore for Summary's own getAcceptanceReadinessV1 fetch.
  // This keeps the list payload tight (~150 bytes per record vs
  // ~500–2000 for the full cache).
  //
  // State enum is validated strictly. Unknown values (forward-compat
  // for future check states, or a malformed write) are silently
  // omitted — the client renders no pill rather than an unknown one.
  // "not_available" is kept on the wire so downstream consumers can
  // render "—" or similar treatments; the Records pill itself omits
  // on "not_available" per PR 103b.
  const rc = data.readinessCache;
  if (rc && typeof rc === "object") {
    const rawState = String(rc.state || "").trim();
    if (
      rawState === "ready_for_submission" ||
      rawState === "requirements_missing" ||
      rawState === "not_available"
    ) {
      const cacheOut = { state: rawState };

      // PR 107a — Project missing-required-check explanations when
      // the state is requirements_missing AND the cache carries a
      // checks[] array. Filter to required-tier rows with
      // satisfied === false (skip unknowns per PR 104 — they don't
      // block state and aren't operator-actionable). Take the first
      // N labels in declared snapshot order (the order
      // computeAcceptanceReadiness emits them).
      if (rawState === "requirements_missing" && Array.isArray(rc.checks)) {
        const PREVIEW_CAP = 3;          // approved decision §10.2
        const LABEL_MAX = 80;           // approved decision §10.3
        const missingRequired = rc.checks.filter(
          (c) => c && c.tier === "required" && c.satisfied === false,
        );
        const missingItemsPreview = missingRequired
          .slice(0, PREVIEW_CAP)
          .map((c) => String(c.label || "").trim().slice(0, LABEL_MAX))
          .filter((s) => s.length > 0);
        // Defensive: only emit preview when we actually have labels.
        // (Cache vintages without populated `label` fields fall through
        // to "pill only, no subline" gracefully.)
        if (missingItemsPreview.length > 0) {
          cacheOut.missingCount = missingRequired.length;
          cacheOut.missingItemsPreview = missingItemsPreview;
        }
      }

      out.readinessCache = cacheOut;
    }
  }

  return out;
}

function toMillis(iso) {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : 0;
}

// PEAKOPS_LIST_INCIDENTS_DISPLAY_TITLE_V1 (2026-04-30)
// Find the best label for a single incident by reading its tasks
// subcollection. Most legacy records were created without an
// incident-level title; the operator typed the work into the first
// task instead. This helper does ONE indexed Firestore read per
// incident (order by createdAt desc, limit 5 to find the active
// task even if it isn't the most recent), then returns the most
// useful task-derived title.
//
// Cost: 1 query per incident, all run in parallel via Promise.all
// at the call site. For a 50-incident dashboard that's 50 parallel
// Firestore reads, ~50–150 ms tail wall time. Bound is enforced
// by `limit` upstream.
//
// Returns:
//   { activeTaskTitle: string, firstTaskTitle: string }
async function loadTaskTitles(db, incidentId) {
  try {
    const snap = await db
      .collection("incidents")
      .doc(String(incidentId || ""))
      .collection("jobs")
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    if (snap.empty) return { activeTaskTitle: "", firstTaskTitle: "" };
    let firstTaskTitle = "";
    let activeTaskTitle = "";
    for (const d of snap.docs) {
      const data = d.data() || {};
      const t = String(data.title || "").trim();
      if (!t) continue;
      // First non-empty task title (most recent first) is the
      // "first task title" fallback.
      if (!firstTaskTitle) firstTaskTitle = t;
      // "Active" = a task currently in progress / open / under
      // review. If multiple match, the most recent wins (loop is
      // already createdAt desc).
      const status = String(data.status || "").trim().toLowerCase();
      const isActive =
        status === "open" ||
        status === "in_progress" ||
        status === "review";
      if (isActive && !activeTaskTitle) activeTaskTitle = t;
    }
    return { activeTaskTitle, firstTaskTitle };
  } catch (e) {
    // Subcollection might not exist yet on this incident, or a
    // missing index. Both are non-fatal — the caller falls through
    // to description / location / "Untitled incident".
    return { activeTaskTitle: "", firstTaskTitle: "" };
  }
}

// PEAKOPS_INCIDENT_IDENTITY_V1 (2026-04-30)
// Canonical incident identity. ONE place computes the displayTitle
// for ALL surfaces. Inputs:
//   out         — partial row already mapped by mapDoc (title, etc.)
//   taskTitles  — { activeTaskTitle, firstTaskTitle } from loadTaskTitles
//   rawData     — original Firestore doc (for description/site fallbacks)
//
// Resolution order (first non-empty wins):
//   1. incident.title           → titleSource: "title"
//   2. primaryTaskTitle         → titleSource: "task"
//        (activeTaskTitle if any task is open/in_progress/review,
//         else firstTaskTitle)
//   3. incident.description     → titleSource: "description"
//   4. incident.location        → titleSource: "location"
//   5. "Untitled incident"      → titleSource: "fallback"
//
// Returns { displayTitle, primaryTaskTitle, titleSource }.
function deriveDisplayTitle(out, taskTitles, rawData) {
  const primaryTaskTitle =
    String(taskTitles?.activeTaskTitle || "").trim() ||
    String(taskTitles?.firstTaskTitle || "").trim();

  // 1. incident.title (mapDoc already covered name/displayName/summary aliases).
  const incidentTitle = String(out.title || "").trim();
  if (incidentTitle) {
    return { displayTitle: incidentTitle, primaryTaskTitle, titleSource: "title" };
  }
  // 2. primaryTaskTitle.
  if (primaryTaskTitle) {
    return { displayTitle: primaryTaskTitle, primaryTaskTitle, titleSource: "task" };
  }
  // 3. description / workDescription (ellipsized at 80 chars).
  const desc = String(
    out.description ||
    rawData?.description ||
    rawData?.workDescription ||
    rawData?.work_description ||
    ""
  ).trim();
  if (desc) {
    const snippet = desc.length > 80 ? desc.slice(0, 78).trimEnd() + "…" : desc;
    return { displayTitle: snippet, primaryTaskTitle, titleSource: "description" };
  }
  // 4. location / site.
  const loc = String(out.location || rawData?.site || "").trim();
  if (loc) return { displayTitle: loc, primaryTaskTitle, titleSource: "location" };
  // 5. fallback.
  return { displayTitle: "Untitled incident", primaryTaskTitle, titleSource: "fallback" };
}

// PEAKOPS_LIST_INCIDENTS_INVOKER_V1 (2026-04-30)
// Explicitly declare `invoker: "public"` so the next firebase deploy
// grants `allUsers` the `run.invoker` IAM role on the underlying
// Cloud Run service. Without this, the Mission Control proxy sees:
//   [listIncidentsV1] org-authenticated { ... }   ← proxy auth ok
//   GET /api/fn/listIncidentsV1 → 401              ← Cloud Run IAM block
// The other v2 functions in this codebase (getIncidentV1, listJobsV1,
// listEvidenceLocker) acquired public invoker via past gcloud calls
// and kept it across redeploys; listIncidentsV1 was a fresh export
// with the project's "private by default" IAM. Auth is NOT weakened —
// the Bearer-token + orgIds-claim gate still runs in the
// enforceOrgAndProxy layer that precedes this function. `invoker:
// "public"` only opens the Cloud Run-level door so the proxy's
// authenticated request can reach the function body.
exports.listIncidentsV1 = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  if (req.method !== "GET") return j(res, 405, { ok: false, error: "GET required" });

  const orgId = String(req.query.orgId || "").trim();
  if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });

  // PEAKOPS_AUTHZ_READ_RETROFIT_V1 (2026-05-06)
  // Phase 1 Slice 6: list incidents for an org is members-only.
  let actorUid = "";
  let actorRole = null;
  try {
    ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
    const gate = await assertActorCanReadOrg(orgId, actorUid);
    actorRole = (gate.membership && gate.membership.role) || null;
  } catch (e) {
    console.warn("[listIncidentsV1] authz_denied", {
      fn: "listIncidentsV1",
      orgId,
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
  console.log("[listIncidentsV1] authz_ok", {
    fn: "listIncidentsV1",
    orgId,
    uid: actorUid,
    role: actorRole,
    capability: "read",
  });

  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const db = getFirestore();
  const seen = new Set();
  // PEAKOPS_LIST_INCIDENTS_DISPLAY_TITLE_V1 (2026-04-30)
  // Carry the raw Firestore data alongside the mapped output so the
  // displayTitle derivation step can read description / site / etc.
  // without re-fetching the doc.
  const merged = []; // entries: { out, raw }
  const sources = { topLevel: 0, orgScoped: 0 };

  // PEAKOPS_LIST_INCIDENTS_ORG_SCOPED_PRIORITY_V1 (2026-05-08)
  // Slice Start Job 1.3.1: read org-scoped FIRST, then top-level
  // (legacy fallback only). Lifecycle-mutating callables
  // (markArrivedV1, submitFieldSessionV1, closeIncidentV1, ...) all
  // route writes through resolveIncidentRef which preferentially
  // targets orgs/{orgId}/incidents/{incidentId}. Reading the
  // top-level copy first meant a stale `status: "in_progress"` on
  // top-level was winning the seen-Set dedup over the canonical
  // org-scoped `status: "submitted"`, so the Jobs index showed
  // In Progress while Detail/Summary (which use getIncidentV1's
  // org-scoped-first read) correctly showed Awaiting Supervisor
  // Review. Flipping the read order aligns the index with the
  // canonical lifecycle resolver. Top-level remains a fallback
  // for any pre-Slice-1 record that exists ONLY at the top-level
  // path.
  try {
    const orgSnap = await db
      .collection(`orgs/${orgId}/incidents`)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    sources.orgScoped = orgSnap.size;
    for (const d of orgSnap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push({ out: mapDoc(d, orgId), raw: d.data() || {} });
    }
  } catch (e) {
    console.warn("[listIncidentsV1] org-scoped read failed", String(e?.message || e));
  }

  try {
    const topSnap = await db
      .collection("incidents")
      .where("orgId", "==", orgId)
      .limit(Math.min(200, limit * 2))
      .get();
    sources.topLevel = topSnap.size;
    for (const d of topSnap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push({ out: mapDoc(d, orgId), raw: d.data() || {} });
    }
  } catch (e) {
    console.warn("[listIncidentsV1] top-level read failed", String(e?.message || e));
  }

  merged.sort((a, b) => toMillis(b.out.updatedAt) - toMillis(a.out.updatedAt));
  const sliced = merged.slice(0, limit);

  // PEAKOPS_LIST_INCIDENTS_DISPLAY_TITLE_V1 (2026-04-30)
  // Parallelized per-incident task lookup. Skips the read entirely
  // when the incident already has its own title (most common case
  // for new records), so the worst-case fan-out is bounded by the
  // count of legacy / task-titled records.
  const taskTitleResults = await Promise.all(
    sliced.map((entry) => {
      const hasIncidentTitle = !!String(entry.out.title || "").trim();
      if (hasIncidentTitle) {
        return Promise.resolve({ activeTaskTitle: "", firstTaskTitle: "" });
      }
      return loadTaskTitles(db, entry.out.id);
    }),
  );

  // PEAKOPS_LIST_INCIDENTS_LIVE_EVIDENCE_COUNT_V1 (PR 116)
  // Live evidence count via Firestore aggregation, parallelized over
  // the sliced rows. Replaces the prior packetMeta.evidenceCount
  // projection which was absent on pre-packet records (Records cards
  // rendered "— evidence" while Summary correctly rendered the live
  // count). evidence_locker lives on the legacy top-level path
  // (incidents/{id}/evidence_locker) per addEvidenceV1, getJobV1,
  // exportIncidentPacketV1, et al. — same path here.
  //
  // Cost: 1 aggregation read per row; billed as 1 read per 1000
  // docs counted. For limit=50 that's ~50 extra reads per /records
  // load. Negligible at current scale.
  //
  // Graceful degradation: any per-row aggregation failure logs a
  // warning, omits the field, and RecordsClient.tsx falls back to
  // "— evidence" (line 394). No broken cards on Firestore errors.
  const evidenceCountResults = await Promise.all(
    sliced.map(async (entry) => {
      try {
        const snap = await db
          .collection("incidents")
          .doc(entry.out.id)
          .collection("evidence_locker")
          .count()
          .get();
        return { id: entry.out.id, count: snap.data().count };
      } catch (e) {
        console.warn("[listIncidentsV1] evidence_locker count failed", {
          incidentId: entry.out.id,
          error: String(e?.message || e),
        });
        return { id: entry.out.id, count: null };
      }
    }),
  );
  const evCountById = new Map(evidenceCountResults.map((r) => [r.id, r.count]));
  for (const entry of sliced) {
    const c = evCountById.get(entry.out.id);
    if (typeof c === "number" && c >= 0) entry.out.evidenceCount = c;
  }

  const incidents = sliced.map((entry, i) => {
    const taskTitles = taskTitleResults[i] || { activeTaskTitle: "", firstTaskTitle: "" };
    const { displayTitle, primaryTaskTitle, titleSource } = deriveDisplayTitle(
      entry.out,
      taskTitles,
      entry.raw,
    );
    // PEAKOPS_INCIDENT_IDENTITY_V1 (2026-04-30)
    // Canonical row shape. `displayTitle` is the single label every
    // frontend surface should render. `primaryTaskTitle` is the
    // task-derived label that contributed (or would have contributed)
    // when incident.title is empty — surfaced separately so a future
    // backfill script can write it back to incident.title.
    const enriched = {
      ...entry.out,
      displayTitle,
      titleSource,
    };
    if (primaryTaskTitle) enriched.primaryTaskTitle = primaryTaskTitle;
    return enriched;
  });

  return j(res, 200, {
    ok: true,
    orgId,
    count: incidents.length,
    incidents,
    sources,
  });
});
