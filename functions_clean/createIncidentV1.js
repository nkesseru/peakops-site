const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

// PEAKOPS_CREATE_INCIDENT_INVOKER_V1 (2026-04-30)
// Match listIncidentsV1: explicit `invoker: "public"` so the next
// firebase deploy grants `allUsers/run.invoker` IAM. Auth is enforced
// by the proxy (enforceOrgAndProxy verifies Firebase ID token + org
// claim before the request reaches this function); this option only
// opens the Cloud Run-level door.
exports.createIncidentV1 = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

  const body = (typeof req.body === "object" && req.body) ? req.body : {};
  const orgId = String(body.orgId || "").trim();

  if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });

  // PEAKOPS_CREATE_INCIDENT_SERVER_ID_V1 (PR 68)
  // incidentId is now OPTIONAL. Original callers (Mission Control's
  // inline /incidents Create form, admin/incidents/page.tsx) supply
  // a client-generated id like inc_20260512_141803_ab12cd. The proof-
  // workflow create flow (PR 69 /incidents/new) omits it and lets
  // the server mint one. Either way, slug-safety is enforced before
  // we write — defense against path traversal and accidental garbage.
  //
  // Server-generated ids use Firestore's auto-id (20-char [A-Za-z0-9]
  // base62), so the slug check below accepts both forms.
  const db = getFirestore();
  let incidentId = String(body.incidentId || "").trim();
  if (!incidentId) {
    incidentId = db.collection("incidents").doc().id;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(incidentId)) {
    return j(res, 400, { ok: false, error: "incidentId must be slug-safe (alnum, _, -, ≤128 chars)" });
  }

  // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
  // Phase 1 Slice 7: incident origination is field-or-above. Field
  // crews routinely log incidents from the field (truck-roll
  // discoveries, follow-up tickets), so the allow-list includes
  // field. Viewer is denied. Upgraded from the Slice 3 membership-
  // only gate. The PEAKOPS_CREATE_INCIDENT_INVOKER_V1 comment block
  // above still applies — proxy auth is the first line; this gate
  // is defense-in-depth at the function level.
  let actorUid = "";
  let actorRole = null;
  try {
    ({ uid: actorUid } = await extractActorUid(req, body));
    const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
    actorRole = (gate.membership && gate.membership.role) || null;
  } catch (e) {
    console.warn("[createIncidentV1] authz_denied", {
      fn: "createIncidentV1",
      orgId,
      incidentId,
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
  console.log("[createIncidentV1] authz_ok", {
    fn: "createIncidentV1",
    orgId,
    incidentId,
    uid: actorUid,
    role: actorRole,
    requiredRoles: ROLES_FIELD_WORK,
  });

  // PEAKOPS_CREATE_INCIDENT_PROOF_WORKFLOW_V1 (PR 68)
  // Title is now REQUIRED and length-bounded. Both existing callers
  // (Mission Control inline /incidents Create form and admin/incidents)
  // already send non-empty titles validated client-side; the new
  // proof-workflow flow (/incidents/new in PR 69) will too. Tightening
  // the server gate ensures we never write a "Untitled record" with
  // no operational signal.
  const title = String(body.title || "").trim();
  if (!title) {
    return j(res, 400, { ok: false, error: "title required" });
  }
  if (title.length < 5 || title.length > 120) {
    return j(res, 400, { ok: false, error: "title must be 5–120 characters" });
  }

  // PEAKOPS_CREATE_INCIDENT_STATUS_ENUM_V1 (PR 68)
  // Default status flips from "open" → "draft" so the proof-workflow
  // create flow starts records in the draft lane (Capture proof is the
  // next step). Legacy callers that send "open" / "active" continue
  // to work; anything outside the enum is rejected. Closed/in_progress
  // are not creation-time statuses and would corrupt the record
  // lifecycle if accepted.
  const STATUS_ENUM = ["draft", "open", "active"];
  const statusRaw = String(body.status || "draft").trim().toLowerCase();
  if (!STATUS_ENUM.includes(statusRaw)) {
    return j(res, 400, {
      ok: false,
      error: `status must be one of ${STATUS_ENUM.join(", ")}`,
    });
  }
  const status = statusRaw;

  const filingTypesRequired = Array.isArray(body.filingTypesRequired) ? body.filingTypesRequired : [];

  // PEAKOPS_CREATE_INCIDENT_FIELDS_V1 (2026-04-28)
  // Optional descriptors captured by the inline /incidents Create form.
  // All optional — empty/missing values are not persisted.
  const location = String(body.location || "").trim();

  // PEAKOPS_CREATE_INCIDENT_PRIORITY_V1 (PR 68)
  // 4-level priority. "high" added between normal and urgent so the
  // proof-workflow form can offer the standard four-step priority
  // ladder. Legacy callers using low/normal/urgent continue to work.
  const PRIORITY_ENUM = ["low", "normal", "high", "urgent"];
  const priorityRaw = String(body.priority || "").trim().toLowerCase();
  const priority = PRIORITY_ENUM.includes(priorityRaw) ? priorityRaw : "";

  const notes = String(body.notes || "").trim();
  if (notes && notes.length > 280) {
    return j(res, 400, { ok: false, error: "notes must be ≤280 characters" });
  }
  const createdBy = String(actorUid || body.createdBy || "").trim();

  // PEAKOPS_CREATE_INCIDENT_JOBTYPE_V1 (2026-04-30)
  // Optional jobType — captured by the Start Job form so the field
  // team can categorize work at intake. Validated against a known
  // set; unknown/empty values are dropped (not persisted) so older
  // callers that don't send the field continue to work, and a
  // tampered payload can't write garbage. Existing records without
  // jobType render normally everywhere; nothing reads this field
  // yet beyond the create write.
  const jobTypeRaw = String(body.jobType || "").trim().toLowerCase();
  const jobType = ["repair", "damage", "inspection", "other"].includes(jobTypeRaw)
    ? jobTypeRaw
    : "";

  // PEAKOPS_CREATE_INCIDENT_PROOF_WORKFLOW_V1 (PR 68)
  // Proof-workflow descriptors. workType is the broad classification
  // (what kind of work this record is for); archetype is the
  // narrower operational template that will eventually drive the
  // capture sequence. Both optional, both enum-checked. Unknown
  // values are silently dropped (not persisted) so a tampered payload
  // can't write garbage, and so existing callers that don't send
  // these fields continue to work.
  const WORK_TYPE_ENUM = [
    "field_operation",
    "field_maintenance",
    "inspection",
    "compliance_audit",
    "other",
  ];
  // PEAKOPS_ARCHETYPE_ENUM_V2 (PR 81a) — additive extension.
  // The original 5 values (pole_inspection, splice_work, cable_install,
  // site_survey, custom) stay so existing records and any legacy
  // callers keep validating. The 3 new values are the
  // commercialization-aligned archetypes the proof-workflow picker
  // (PR 81b) surfaces in the UI:
  //   - fiber_splice_verification : completion-proof for customer
  //     acceptance + invoice support (semantic narrowing of splice_work)
  //   - site_acceptance : closeout-proof for customer sign-off
  //     (semantic narrowing of site_survey)
  //   - storm_restoration_proof : after-action proof for claim +
  //     reimbursement workflows (new archetype, no prior key)
  // Backend stays additive on the enum so we never break a write
  // that worked yesterday.
  const ARCHETYPE_ENUM = [
    "pole_inspection",
    "splice_work",
    "cable_install",
    "site_survey",
    "custom",
    "fiber_splice_verification",
    "site_acceptance",
    "storm_restoration_proof",
  ];
  const workTypeRaw = String(body.workType || "").trim().toLowerCase();
  const workType = WORK_TYPE_ENUM.includes(workTypeRaw) ? workTypeRaw : "";
  const archetypeRaw = String(body.archetype || "").trim().toLowerCase();
  const archetype = ARCHETYPE_ENUM.includes(archetypeRaw) ? archetypeRaw : "";

  // PEAKOPS_CREATE_INCIDENT_PROOF_CONTEXT_V1 (PR 68b)
  // Operational context descriptors captured by the proof-workflow
  // form (PR 69 /incidents/new). Both optional, both length-bounded.
  // customer is free text (could be a customer name, agency name, or
  // project label depending on the user's industry); externalWorkOrderId
  // is the upstream ticket id we cross-reference against — kept slug-ish
  // so it can safely round-trip into URLs and filenames.
  const customer = String(body.customer || "").trim();
  if (customer && customer.length > 120) {
    return j(res, 400, { ok: false, error: "customer must be ≤120 characters" });
  }
  const externalWorkOrderId = String(body.externalWorkOrderId || "").trim();
  if (externalWorkOrderId) {
    if (externalWorkOrderId.length > 64) {
      return j(res, 400, { ok: false, error: "externalWorkOrderId must be ≤64 characters" });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(externalWorkOrderId)) {
      return j(res, 400, { ok: false, error: "externalWorkOrderId must contain only letters, digits, _ and -" });
    }
  }

  // PEAKOPS_CREATE_INCIDENT_DUAL_WRITE_V1 (2026-04-29)
  // The codebase has TWO incident paths:
  //   - top-level `incidents/{id}` (canonical — listJobsV1,
  //     closeIncidentV1, saveIncidentNotesV1, createJobV1,
  //     approveAndLockJobV1, etc. all read/write here)
  //   - per-org `orgs/{orgId}/incidents/{id}` (legacy of an earlier
  //     pass; getIncidentV1 still reads it as a primary path)
  //
  // Until the data model is unified, write the parent doc to BOTH so
  // a Mission-Control-created incident is fully reachable by every
  // existing pipeline (jobs, notes, close, approve, generate report).
  // Pre-existence check uses the canonical top-level path.
  const topRef = db.collection("incidents").doc(incidentId);
  const orgRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);

  try {
    const [topExisting, orgExisting] = await Promise.all([
      topRef.get(),
      orgRef.get(),
    ]);
    if (topExisting.exists || orgExisting.exists) {
      return j(res, 409, { ok: false, error: "Incident already exists", orgId, incidentId });
    }

    const doc = {
      orgId,
      incidentId,
      title,
      status,
      filingTypesRequired,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (location) doc.location = location;
    if (priority) doc.priority = priority;
    if (notes) doc.notes = notes;
    if (createdBy) doc.createdBy = createdBy;
    if (jobType) doc.jobType = jobType;
    if (workType) doc.workType = workType;
    if (archetype) doc.archetype = archetype;
    if (customer) doc.customer = customer;
    if (externalWorkOrderId) doc.externalWorkOrderId = externalWorkOrderId;

    // Write both copies in parallel. If the org-scoped write fails
    // (e.g., because security rules diverge), the top-level write is
    // the one downstream pipelines actually need; the org-scoped copy
    // is a redundant convenience.
    await Promise.all([
      topRef.set(doc),
      orgRef.set(doc).catch((e) => {
        console.warn("[createIncidentV1] org-scoped write failed (non-fatal)", String(e?.message || e));
      }),
    ]);

    return j(res, 201, { ok: true, orgId, incidentId });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
