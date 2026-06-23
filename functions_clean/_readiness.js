// PEAKOPS_ACCEPTANCE_READINESS_V1 (PR 103a)
// PEAKOPS_ACCEPTANCE_CHECKS_V1   (PR 104)
//
// Deterministic projection of an incident's acceptance readiness from
// state PeakOps already records:
//
//   - incident.requirements          (PR 89a snapshot — required proof contract)
//   - evidence_locker[].requirementKey (PR 94a — operator-bound slot tags)
//   - jobs[].decision === "approved"   (per-task supervisor approval)
//   - incident.status === "closed"     (lifecycle gate)
//
// PR 104 — adds per-customer-template acceptance checks. The snapshot
// can carry `acceptanceChecks: AcceptanceCheck[]` which the engine
// evaluates with a small enum of named pure functions (5 in MVP).
// Author-controlled tier (required vs encouraged). Snapshot frozen
// at incident creation; template edits never rewrite history. Unknown
// check types render as neutral "satisfied: unknown" rows that do
// NOT block state — preserves trust + auditability per approved
// decision §5.
//
// Output is a stateless projection — readiness IS the current data, so
// it's computed on demand and (optionally) cached on the incident doc
// for fast Records-page reads. The cache is a courtesy, not a source
// of truth — recompute any time and the answer must match.
//
// What this helper is NOT:
//   - Not AI / scoring / prediction / probability
//   - Not a percentage (counts only — never "67% ready")
//   - Not a workflow engine / form builder / FSM / regex rule engine
//   - Not a dynamic evaluation language — every check is a named,
//     hand-written pure function in TEMPLATE_CHECK_EVALUATORS below.
//     Adding a check type requires explicit engineering work
//     (per approved decision §1 — avoid check-type explosion).
//   - Not a validation engine — only reports satisfied / unsatisfied
//   - Not opinionated about export gating; gating is the caller's call
//
// State labels (operational, not aspirational):
//   - "ready_for_submission"  : every REQUIRED check satisfied
//                               (unknown checks do NOT block state)
//   - "requirements_missing"  : at least one REQUIRED check unsatisfied
//                               (with satisfied === false; unknown
//                               checks are not counted as unsatisfied)
//   - "not_available"         : no checks could be evaluated (legacy
//                               incident with no snapshot AND no
//                               evidence — can't compute meaningfully)
//
// Tier semantics:
//   - "required"   : must ALL be satisfied for "ready_for_submission"
//   - "encouraged" : reported but doesn't gate state
//
// Satisfied semantics:
//   - true       : check passed
//   - false      : check failed
//   - "unknown"  : check type not recognized by current backend
//                  (PR 104 forward-compat for new check types added
//                  in later releases; renders as neutral ⚠ row but
//                  does NOT influence state)

// Mirrors next-app/AddEvidenceClient.tsx slugRequirement byte-for-byte
// AND the matching helper in exportIncidentPacketV1.js — keep these in
// sync if the algorithm ever changes. Backend regex
// ^[a-z0-9-]{1,120}$ stays satisfied.
function slugRequirement(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

// ─── PR 104 — Template-driven acceptance check evaluators ─────────
//
// Each evaluator is a named pure function taking (check, context)
// and returning a ReadinessCheck row. The dispatch map below is the
// AUTHORITATIVE list of known check types — adding a check type
// means writing an evaluator AND adding it to the map. There is no
// dynamic evaluation language. This is the line that holds PeakOps
// back from becoming a workflow engine.
//
// MVP enum (5 types) per approved decision §1:
//   - requires_minimum_proof_count       (params.minCount: number)
//   - requires_supervisor_approval
//   - requires_at_least_one_gps_proof    (lenient per §2)
//   - requires_field_notes
//   - requires_incident_closure
//
// Unknown types route through evaluateUnknownTemplateCheck and emit
// satisfied: "unknown" rows that do not block state (§5).

function _normTier(t) {
  return t === "required" ? "required" : "encouraged";
}

// PEAKOPS_READINESS_CLOSURE_TERMINAL_STATUSES_V1 (2026-06-15)
// Statuses that satisfy the "incident closure" readiness check.
// `closed` is the legacy operational terminal; `customer_accepted`
// is the PR 126a customer-review terminal. `accepted`, `approved`,
// and `exported` are accepted as aliases for orgs whose lifecycle
// uses different terminal names. Lowercased + trimmed comparison.
// Intentionally does NOT include: open, in_progress, draft,
// submitted_to_customer, customer_rejected — those are mid-flight
// and the operator should still know the record isn't done.
const TERMINAL_ACCEPTED_STATUSES = new Set([
  "closed",
  "customer_accepted",
  "accepted",
  "approved",
  "exported",
]);
function _isTerminalAccepted(rawStatus) {
  const s = String(rawStatus || "").trim().toLowerCase();
  return TERMINAL_ACCEPTED_STATUSES.has(s);
}

// PEAKOPS_CUSTOMER_CHECK_LABELS_V1 (PR 118)
// Customer-authored check.label / check.description override the
// evaluator's built-in defaults so the customer's exact acceptance
// language flows through readinessCache → Records pill, Summary
// dossier, export packet. createIncidentV1 sanitizes both fields
// at snapshot write (trim + control-char strip + 200/500 char caps)
// so values reaching here are already safe; we still defensively
// trim and string-coerce to absorb upstream drift.
//
// Empty/whitespace label → fall back to the evaluator's default
// (NOT the empty string; that would degrade UX). Empty description
// → omitted from the emitted check row.
function _resolveLabel(check, fallback) {
  const v = String((check && check.label) || "").trim();
  return v.length > 0 ? v : fallback;
}
function _resolveDescription(check) {
  const v = String((check && check.description) || "").trim();
  return v.length > 0 ? v : undefined;
}

// PEAKOPS_SUPERVISOR_APPROVAL_SIGNAL_V1 (PR 115)
// Mirrors exportIncidentPacketV1.isApprovedJob (line 152) — the
// production-canonical "is this job approved" signal. Aligning the
// readiness evaluator closes the long-standing gap where approveJobV1
// (writes status: "approved" only) satisfied the export pipeline,
// setEvidenceLabelV1, and updateJobStatusV1 — but NOT the readiness
// supervisor_approval check. Three accept signals OR'd together:
//   - status === "approved"      : written by approveJobV1 +
//                                  approveAndLockJobV1
//   - reviewStatus === "approved": written by approveAndLockJobV1
//   - decision === "approved"    : legacy field, kept as a read
//                                  fallback for older job docs
function _isJobApproved(j) {
  const st  = String(j?.status       || "").trim().toLowerCase();
  const rs  = String(j?.reviewStatus || "").trim().toLowerCase();
  const dec = String(j?.decision     || "").trim().toLowerCase();
  return st === "approved" || rs === "approved" || dec === "approved";
}

function evaluateRequiresMinimumProofCount(check, { evidence }) {
  const minRaw = Number(check?.params?.minCount);
  const min = Number.isFinite(minRaw) && minRaw >= 1 ? Math.floor(minRaw) : 1;
  const have = (Array.isArray(evidence) ? evidence : []).length;
  const description = _resolveDescription(check);
  const row = {
    key: `template_check__min_proof_${min}`,
    label: _resolveLabel(check, `Minimum ${min} proof ${min === 1 ? "item" : "items"}`),
    category: "template_check",
    tier: _normTier(check.tier),
    satisfied: have >= min,
    detail: `${have} of ${min} captured`,
  };
  if (description) row.description = description;
  return row;
}

function evaluateRequiresSupervisorApproval(check, { jobs }) {
  const jobList = Array.isArray(jobs) ? jobs : [];
  // PR 115 — uses _isJobApproved so status:"approved" (the value
  // approveJobV1 writes) counts as supervisor approval, matching
  // exportIncidentPacketV1.isApprovedJob.
  const approved = jobList.filter(_isJobApproved).length;
  const description = _resolveDescription(check);
  const row = {
    key: "template_check__supervisor_approval",
    label: _resolveLabel(check, "Supervisor approval"),
    category: "template_check",
    tier: _normTier(check.tier),
    satisfied: approved > 0,
    detail: approved > 0
      ? `${approved} of ${jobList.length} ${jobList.length === 1 ? "task" : "tasks"} approved`
      : "No tasks approved yet",
  };
  if (description) row.description = description;
  return row;
}

function evaluateRequiresAtLeastOneGpsProof(check, { evidence }) {
  // Lenient interpretation per approved decision §2: at-least-one is
  // enough (proof someone was on site). Strict per-photo variants
  // can be added later as a separate enum entry if customers ask.
  const withGps = (Array.isArray(evidence) ? evidence : []).filter((ev) => {
    const lat = Number(ev?.gps?.lat);
    const lng = Number(ev?.gps?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
  }).length;
  const description = _resolveDescription(check);
  const row = {
    key: "template_check__at_least_one_gps_proof",
    label: _resolveLabel(check, "At least one GPS-tagged proof"),
    category: "template_check",
    tier: _normTier(check.tier),
    satisfied: withGps > 0,
    detail: withGps > 0
      ? `${withGps} proof item${withGps === 1 ? "" : "s"} with GPS`
      : "No proof items have GPS coordinates",
  };
  if (description) row.description = description;
  return row;
}

function evaluateRequiresFieldNotes(check, { incident, notes }) {
  // Notes may live on the incident doc directly (incidentNotes /
  // siteNotes) OR be loaded separately by the caller (notes
  // context arg). Both checked so this works whether the caller
  // passed pre-loaded notes or just the raw incident doc.
  const a = String(incident?.incidentNotes || notes?.incidentNotes || "").trim();
  const b = String(incident?.siteNotes || notes?.siteNotes || "").trim();
  const have = !!(a || b);
  const description = _resolveDescription(check);
  const row = {
    key: "template_check__field_notes",
    label: _resolveLabel(check, "Field notes captured"),
    category: "template_check",
    tier: _normTier(check.tier),
    satisfied: have,
    detail: have ? "Notes recorded" : "No notes recorded",
  };
  if (description) row.description = description;
  return row;
}

function evaluateRequiresIncidentClosure(check, { incident }) {
  const status = String(incident?.status || "").trim().toLowerCase();
  const closed = _isTerminalAccepted(status);
  const description = _resolveDescription(check);
  const row = {
    key: "template_check__incident_closure",
    label: _resolveLabel(check, "Incident closure"),
    category: "template_check",
    tier: _normTier(check.tier),
    satisfied: closed,
    detail: closed ? `Closed (${status})` : `Status: ${status || "(unknown)"}`,
  };
  if (description) row.description = description;
  return row;
}

const TEMPLATE_CHECK_EVALUATORS = {
  requires_minimum_proof_count: evaluateRequiresMinimumProofCount,
  requires_supervisor_approval: evaluateRequiresSupervisorApproval,
  requires_at_least_one_gps_proof: evaluateRequiresAtLeastOneGpsProof,
  requires_field_notes: evaluateRequiresFieldNotes,
  requires_incident_closure: evaluateRequiresIncidentClosure,
};

function evaluateUnknownTemplateCheck(check) {
  // Per approved decision §5: do NOT silently skip. Render a
  // neutral ⚠ row with satisfied: "unknown". State computation
  // explicitly excludes "unknown" so this never blocks readiness.
  const typeRaw = String(check?.type || "(unspecified)").trim() || "(unspecified)";
  return {
    key: `template_check_unknown__${typeRaw}`,
    label: `Unknown acceptance check: ${typeRaw}`,
    category: "template_check_unknown",
    tier: _normTier(check?.tier),
    satisfied: "unknown",
    detail: "This check type isn't recognized by the current backend.",
  };
}

function evaluateTemplateCheck(check, context) {
  if (!check || typeof check !== "object") return null;
  const type = String(check.type || "").trim();
  if (!type) return null;  // malformed entry, drop silently
  const evaluator = TEMPLATE_CHECK_EVALUATORS[type];
  if (!evaluator) return evaluateUnknownTemplateCheck(check);
  try {
    return evaluator(check, context);
  } catch (e) {
    // Evaluator threw (shouldn't happen for our small set, but
    // future evaluators might if context shape drifts). Treat as
    // unknown so we don't crash the whole readiness compute.
    return {
      ...evaluateUnknownTemplateCheck({ type, tier: check.tier }),
      detail: `Evaluator error: ${String(e?.message || e).slice(0, 120)}`,
    };
  }
}

/**
 * Compute acceptance readiness from raw incident state.
 *
 * @param {object} args
 * @param {object} args.incident   — incident doc (must include status,
 *                                   may include requirements snapshot)
 * @param {Array}  args.evidence   — array of evidence_locker docs
 * @param {Array}  args.jobs       — array of job docs
 * @param {object} [args.notes]    — optional notes subdoc
 *                                   (incidents/{id}/notes/main) used by
 *                                   the field-notes evaluator when the
 *                                   notes don't live on the incident doc
 *                                   itself
 * @returns {object} readiness projection (see shape below)
 */
function computeAcceptanceReadiness({ incident, evidence, jobs, notes }) {
  const checks = [];

  // ─── REQUIRED PROOF CHECKS ────────────────────────────────────
  // One check per declared required-proof item. Satisfied when at
  // least one evidence doc carries the matching requirementKey.
  // A doc's requirementKey is trusted only if it passes the backend
  // regex (matches client/export slug derivation).

  const reqSnapshot =
    incident && incident.requirements && typeof incident.requirements === "object"
      ? incident.requirements
      : null;
  const reqLabels = reqSnapshot && Array.isArray(reqSnapshot.requiredProof)
    ? reqSnapshot.requiredProof.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
    : [];
  const reqSource = String(reqSnapshot?.source || "").trim() || "none";

  // Per-slot satisfaction lookup.
  const evidenceByKey = new Map();
  const evList = Array.isArray(evidence) ? evidence : [];
  for (const ev of evList) {
    const k = String(ev?.requirementKey || "").trim();
    if (!k || !/^[a-z0-9-]{1,120}$/.test(k)) continue;
    if (!evidenceByKey.has(k)) evidenceByKey.set(k, 0);
    evidenceByKey.set(k, evidenceByKey.get(k) + 1);
  }

  // PEAKOPS_TEMPLATE_PROVENANCE_V1 (PR 120a)
  // Per-required-proof rationales authored by the customer template
  // (PR 119a editor) and frozen into the snapshot by createIncidentV1.
  // Parallel array; same length as requiredProof. Emit on the check
  // row when non-empty so AcceptanceReadinessPanel + Summary dossier
  // can render "Reason: …" inline.
  const reqDescriptions = reqSnapshot && Array.isArray(reqSnapshot.requiredProofDescriptions)
    ? reqSnapshot.requiredProofDescriptions
    : [];
  for (let i = 0; i < reqLabels.length; i++) {
    const label = reqLabels[i];
    const key = slugRequirement(label);
    const count = key ? (evidenceByKey.get(key) || 0) : 0;
    const satisfied = count > 0;
    const row = {
      key: `required_proof__${key || `slot_${i + 1}`}`,
      label,
      category: "required_proof",
      tier: "required",
      satisfied,
      detail: satisfied
        ? `${count} ${count === 1 ? "photo" : "photos"} captured`
        : "No proof captured",
    };
    const desc = String(reqDescriptions[i] || "").trim();
    if (desc) row.description = desc;
    checks.push(row);
  }

  // ─── SUPERVISOR APPROVAL CHECK ────────────────────────────────
  // PR 115 — Satisfied when ≥1 job passes _isJobApproved, which
  // mirrors exportIncidentPacketV1.isApprovedJob exactly. status,
  // reviewStatus, and decision are OR'd; matches the rule used by
  // setEvidenceLabelV1 and updateJobStatusV1 elsewhere in the system.
  const jobList = Array.isArray(jobs) ? jobs : [];
  const approvedJobs = jobList.filter(_isJobApproved);
  checks.push({
    key: "supervisor_approval",
    label: "Supervisor approval",
    category: "approval",
    tier: "required",
    satisfied: approvedJobs.length > 0,
    detail: approvedJobs.length > 0
      ? `${approvedJobs.length} of ${jobList.length} ${jobList.length === 1 ? "task" : "tasks"} approved`
      : "No tasks approved yet",
  });

  // ─── INCIDENT CLOSURE CHECK ───────────────────────────────────
  // Satisfied when the incident has reached a terminal-accepted
  // status — legacy "closed", PR 126a "customer_accepted", or one
  // of the alias terminal names. See TERMINAL_ACCEPTED_STATUSES.
  // Mid-flight statuses (open, in_progress, submitted_to_customer,
  // customer_rejected, draft) remain unsatisfied so the operator
  // sees the record isn't done.
  const statusRaw = String(incident?.status || "").trim().toLowerCase();
  const isClosed = _isTerminalAccepted(statusRaw);
  checks.push({
    key: "incident_closure",
    label: "Incident closure",
    category: "closure",
    tier: "required",
    satisfied: isClosed,
    detail: isClosed ? `Closed (${statusRaw})` : `Status: ${statusRaw || "(unknown)"}`,
  });

  // ─── LEGACY FALLBACK CHECK ────────────────────────────────────
  // Pre-PR-89a incidents have no requirements snapshot. We can't
  // evaluate per-slot satisfaction. Surface a single fallback check
  // — at least one evidence doc exists — so the incident's readiness
  // isn't an empty void.
  if (reqLabels.length === 0) {
    checks.push({
      key: "legacy_evidence_present",
      label: "At least one evidence doc",
      category: "required_proof",
      tier: "required",
      satisfied: evList.length > 0,
      detail: evList.length > 0
        ? `${evList.length} ${evList.length === 1 ? "evidence doc" : "evidence docs"}`
        : "No evidence captured",
    });
  }

  // ─── PR 104 — TEMPLATE-DRIVEN ACCEPTANCE CHECKS ───────────────
  // Walk the snapshotted acceptanceChecks (frozen at incident
  // creation per approved decision §4). Each check routes through
  // evaluateTemplateCheck which dispatches to a known evaluator OR
  // returns a neutral "unknown" row. Tier is author-controlled per
  // check (§3). Universal checks above run independently; if a
  // template includes a check that overlaps a universal one (e.g.,
  // requires_supervisor_approval), both rows render so the audit
  // trail shows which authority asked for each.
  const templateChecksRaw = Array.isArray(reqSnapshot?.acceptanceChecks)
    ? reqSnapshot.acceptanceChecks
    : [];
  for (const tc of templateChecksRaw) {
    const row = evaluateTemplateCheck(tc, { incident, evidence: evList, jobs: jobList, notes });
    if (row) checks.push(row);
  }

  // ─── STATE COMPUTATION ────────────────────────────────────────
  // PR 104 — "unknown" satisfaction values do NOT count as
  // unsatisfied. State counts only true/false rows. This preserves
  // forward-compat: a template that references a check type the
  // current backend doesn't know about won't block readiness.
  const requiredChecks = checks.filter((c) => c.tier === "required");
  const encouragedChecks = checks.filter((c) => c.tier === "encouraged");
  const requiredSatisfied = requiredChecks.filter((c) => c.satisfied === true).length;
  const requiredKnown = requiredChecks.filter((c) => c.satisfied === true || c.satisfied === false).length;
  const requiredUnknown = requiredChecks.filter((c) => c.satisfied === "unknown").length;
  const encouragedSatisfied = encouragedChecks.filter((c) => c.satisfied === true).length;
  const encouragedUnknown = encouragedChecks.filter((c) => c.satisfied === "unknown").length;

  // "not_available" — pre-PR-89a legacy incident with NO snapshot
  // AND no evidence. The legacy_evidence_present check is the only
  // required signal and it's unsatisfied; we can't say anything
  // meaningful about readiness without either proof or a contract.
  let state;
  if (reqLabels.length === 0 && evList.length === 0) {
    state = "not_available";
  } else if (requiredSatisfied === requiredKnown) {
    // All KNOWN required checks are satisfied. Unknowns are reported
    // but ignored for state purposes (§5).
    state = "ready_for_submission";
  } else {
    state = "requirements_missing";
  }

  return {
    readinessVersion: 1,
    state,
    generatedAt: new Date().toISOString(),
    requirementsSnapshotSource: reqLabels.length > 0 ? reqSource : "none",
    summary: {
      requiredSatisfied,
      requiredTotal: requiredChecks.length,
      requiredUnknown,
      encouragedSatisfied,
      encouragedTotal: encouragedChecks.length,
      encouragedUnknown,
    },
    checks,
  };
}

// PEAKOPS_READINESS_FRESHNESS_V1 (PR 108)
//
// Recompute + persist readinessCache for a single incident. Mutation
// callables (addEvidenceV1, approveJobV1, closeIncidentV1,
// saveIncidentNotesV1) await this AFTER their primary write so the
// next list/read sees the new state without waiting on a Summary view
// or an explicit getAcceptanceReadinessV1 call.
//
// Resolution mirrors getAcceptanceReadinessV1: prefer the org-scoped
// incident doc, fall back to legacy top-level. Subcollections are
// always read from the legacy path (jobs / evidence_locker / notes
// all live there). The cache is written to whichever ref the incident
// doc actually exists at so reads stay aligned.
//
// Bulletproof contract: this function NEVER throws. All errors are
// logged as warnings and swallowed; the caller's mutation is never
// affected by cache-refresh failure. Returns the freshly computed
// readiness object on success, or null on any failure path.
// PR 133B — Passive validation hook constants.
//
// Org-level config doc at `orgs/{orgId}/config/validation` with shape
// `{ mode: "off" | "passive_log" | "passive_persist" }`. Absent doc
// or unknown mode value is treated as "off". `passive_log` runs the
// validation engine and logs results to Cloud Logging but does NOT
// persist anything to the incident doc. `passive_persist` runs +
// logs + writes `incident.complianceReadiness`. No mode causes
// blocking behavior anywhere in this PR.
const VALIDATION_MODE_OFF = "off";
const VALIDATION_MODE_PASSIVE_LOG = "passive_log";
const VALIDATION_MODE_PASSIVE_PERSIST = "passive_persist";
// PR 133C — enforcement mode. Recognized by readValidationMode so the
// in-memory cache normalizes it correctly, and treated as a "runs the
// engine" mode for refreshReadinessCache's compliance-result writing
// path (block mode wants the same persisted findings as
// passive_persist so the operator UI can show them). Actual
// blocking happens in _enforcement.js at the three gated callables.
const VALIDATION_MODE_BLOCK = "block";
const VALIDATION_MODES_THAT_RUN = new Set([
  VALIDATION_MODE_PASSIVE_LOG,
  VALIDATION_MODE_PASSIVE_PERSIST,
  VALIDATION_MODE_BLOCK,
]);

// In-memory cache of the per-org validation mode. Cuts a Firestore read
// per refreshReadinessCache call. TTL is intentional: 60s is plenty for
// the safety property (kill-switch within a minute) without hammering
// the config doc on every state change. Set to 0 to disable caching
// (used by smoke).
const __validationModeCache = new Map();
const VALIDATION_MODE_TTL_MS = 60_000;

async function readValidationMode(db, orgId) {
  const now = Date.now();
  const cached = __validationModeCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.mode;
  let mode = VALIDATION_MODE_OFF;
  try {
    const cfgSnap = await db.doc(`orgs/${orgId}/config/validation`).get();
    if (cfgSnap.exists) {
      const raw = String((cfgSnap.data() || {}).mode || "").trim().toLowerCase();
      if (VALIDATION_MODES_THAT_RUN.has(raw) || raw === VALIDATION_MODE_OFF) {
        mode = raw;
      }
    }
  } catch (_e) {
    // Config read failure → fail closed → off.
    mode = VALIDATION_MODE_OFF;
  }
  __validationModeCache.set(orgId, { mode, expiresAt: now + VALIDATION_MODE_TTL_MS });
  return mode;
}

// Test-only: bust the cache so smoke scenarios can flip the flag mid-run.
function __resetValidationModeCacheForTests() {
  __validationModeCache.clear();
}

// PR 133B — Compute passive compliance readiness for an incident.
// Pure compute + optional persist. Caller (refreshReadinessCache)
// is responsible for the mode gate and for choosing whether to call
// this function. This helper is exported so smoke can drive it
// directly with synthetic incidents.
//
// PASSIVE VALIDATION — does NOT gate any operator workflow. Never
// returns an error that blocks the caller. PR 133B.
function computeComplianceReadiness({ incident, evidence }) {
  const { runComplianceCheck } = require("./_complianceValidator");
  const evidenceTypesPresent = (Array.isArray(evidence) ? evidence : [])
    .map((e) => String(
      (e && e.type) ||
      (e && e.kind) ||
      (e && e.file && (e.file.contentType || e.file.mimeType)) ||
      ""
    ))
    .map((s) => s.toUpperCase())
    .filter(Boolean);

  const t0 = Date.now();
  const result = runComplianceCheck(incident, evidenceTypesPresent);
  const elapsedMs = Date.now() - t0;

  // Derive the operator-readable state. Critical: do NOT conflate
  // `ok: true` with "clear" — WARN/INFO issues should surface as
  // `issues_advisory`, not as a green light.
  const errorCount = result.issues.filter((i) => i.severity === "ERROR").length;
  const warnCount = result.issues.filter((i) => i.severity === "WARN").length;
  const infoCount = result.issues.filter((i) => i.severity === "INFO").length;
  const filingTypes = Array.isArray(incident && incident.filingTypesRequired)
    ? incident.filingTypesRequired
    : [];

  let state;
  if (filingTypes.length === 0) {
    state = "not_evaluated";          // nothing to check ≠ green
  } else if (errorCount > 0) {
    state = "issues_blocking";
  } else if (warnCount > 0 || infoCount > 0) {
    state = "issues_advisory";        // engine OK but signal worth knowing
  } else {
    state = "clear";
  }

  // Cap the issues array at 50 (ERROR + WARN first) so the doc field
  // never balloons.
  const SEV_ORDER = { ERROR: 0, WARN: 1, INFO: 2 };
  const sortedIssues = result.issues
    .slice()
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3))
    .slice(0, 50);

  // Missing-fields projection: dedupe `incident.<path>` portions of
  // issue.path for the rules that use `require.field`.
  const missingFields = Array.from(new Set(
    sortedIssues
      .filter((i) => i.path && i.path.startsWith("incident."))
      .map((i) => i.path.slice("incident.".length))
  )).slice(0, 20);

  const topIssueCodes = Array.from(new Set(sortedIssues.map((i) => i.code))).slice(0, 5);

  return {
    state,
    ok: result.ok,
    filingTypes,
    rulepackVersions: result.rulepackVersionsByType || {},
    issues: sortedIssues,
    summary: {
      errorCount, warnCount, infoCount,
      topIssueCodes,
      missingFields,
    },
    incidentVersion: incident && typeof incident.version === "number" ? incident.version : null,
    elapsedMs,
  };
}

async function refreshReadinessCache({ orgId, incidentId }) {
  try {
    if (!orgId || !incidentId) {
      console.warn("[refreshReadinessCache] missing_ids", { orgId, incidentId });
      return null;
    }

    // Lazy-require admin so this module remains importable in
    // contexts that don't have firebase-admin available (e.g.,
    // future unit tests of the pure compute path).
    // Use the modular `firebase-admin/firestore` entrypoint to match
    // the four wired mutation callables. The legacy
    // `admin.firestore.FieldValue` namespace access works in the
    // deployed runtime but is unreliable in the functions emulator —
    // the modular form works in both.
    const { getFirestore, FieldValue } = require("firebase-admin/firestore");
    const db = getFirestore();

    // Resolve incident ref — same pattern as getAcceptanceReadinessV1.
    let incRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let incSnap = await incRef.get();
    if (!incSnap.exists) {
      incRef = db.collection("incidents").doc(incidentId);
      incSnap = await incRef.get();
    }
    if (!incSnap.exists) {
      console.warn("[refreshReadinessCache] incident_not_found", { orgId, incidentId });
      return null;
    }
    const incident = { id: incSnap.id, ...incSnap.data() };

    // Subcollections live on legacy top-level path.
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

    const cachePayload = {
      ...readiness,
      cachedAt: FieldValue.serverTimestamp(),
    };
    await incRef.set({ readinessCache: cachePayload }, { merge: true });

    // PR 133B — PASSIVE VALIDATION. Runs only when org flag is
    // explicitly opted in. Never gates the readiness write above;
    // failures here are swallowed and logged. Three modes:
    //   off            — no compute, no log, no write
    //   passive_log    — compute + log; do NOT write field
    //   passive_persist — compute + log + write incident.complianceReadiness
    // Default for any org without the config doc is "off".
    try {
      const validationMode = await readValidationMode(db, orgId);
      if (VALIDATION_MODES_THAT_RUN.has(validationMode)) {
        const compliance = computeComplianceReadiness({ incident, evidence });
        // Always log (both passive modes log). Keep the log line
        // compact — full issues + topIssueCodes give enough signal
        // for the 24-hour observation window.
        console.log("[refreshReadinessCache] compliance_check", {
          orgId,
          incidentId,
          mode: validationMode,
          state: compliance.state,
          ok: compliance.ok,
          filingTypes: compliance.filingTypes,
          errorCount: compliance.summary.errorCount,
          warnCount: compliance.summary.warnCount,
          infoCount: compliance.summary.infoCount,
          topIssueCodes: compliance.summary.topIssueCodes,
          missingFields: compliance.summary.missingFields,
          elapsedMs: compliance.elapsedMs,
        });
        if (validationMode === VALIDATION_MODE_PASSIVE_PERSIST ||
            validationMode === VALIDATION_MODE_BLOCK) {
          // PR 133C — block mode persists too, so the operator UI can
          // surface findings and explain WHY the gated callable refused.
          // Strip the `elapsedMs` field from the persisted snapshot —
          // it's instrumentation, not state. Add serverTimestamp.
          const { elapsedMs: _drop, ...persistedShape } = compliance;
          await incRef.set({
            complianceReadiness: {
              ...persistedShape,
              ranAt: FieldValue.serverTimestamp(),
            },
          }, { merge: true });
        }
      }
    } catch (passiveErr) {
      // PASSIVE VALIDATION — log and continue. Must not affect
      // refreshReadinessCache's primary outcome.
      console.warn("[refreshReadinessCache] passive_validation_failed", {
        orgId, incidentId, error: String(passiveErr?.message || passiveErr),
      });
    }

    return readiness;
  } catch (e) {
    console.warn("[refreshReadinessCache] failed", {
      orgId, incidentId, error: String(e?.message || e),
    });
    return null;
  }
}

module.exports = {
  computeAcceptanceReadiness,
  refreshReadinessCache,
  slugRequirement,  // exported so tests can verify shared logic
  // PR 133B — passive validation surface (exported for smoke tests)
  computeComplianceReadiness,
  readValidationMode,
  __resetValidationModeCacheForTests,
  VALIDATION_MODE_OFF,
  VALIDATION_MODE_PASSIVE_LOG,
  VALIDATION_MODE_PASSIVE_PERSIST,
  VALIDATION_MODE_BLOCK,
};
