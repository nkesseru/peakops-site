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
  const incidentId = String(body.incidentId || "").trim();

  if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
  if (!incidentId) return j(res, 400, { ok: false, error: "incidentId required" });

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

  const title = String(body.title || "").trim();
  const status = String(body.status || "open").trim().toLowerCase();
  const filingTypesRequired = Array.isArray(body.filingTypesRequired) ? body.filingTypesRequired : [];

  // PEAKOPS_CREATE_INCIDENT_FIELDS_V1 (2026-04-28)
  // Optional descriptors captured by the inline /incidents Create form.
  // All optional — empty/missing values are not persisted.
  const location = String(body.location || "").trim();
  const priorityRaw = String(body.priority || "").trim().toLowerCase();
  const priority = ["low", "normal", "urgent"].includes(priorityRaw) ? priorityRaw : "";
  const notes = String(body.notes || "").trim();
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

  const db = getFirestore();

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
