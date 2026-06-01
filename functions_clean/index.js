require("./_emu_bootstrap");

// Safe optional loader
function safeExport(name, path) {
  try {
    exports[name] = require(path)[name];
    console.log("[functions_clean] loaded", name);
  } catch (e) {
    console.log("[functions_clean] skipped", name, (e && e.message) ? e.message : e);
    console.log((e && e.stack) ? e.stack : "");
  }
}

// --- Core health / debug ---
safeExport("hello", "./hello");
safeExport("healthzV1", "./healthzV1");

// --- Incident core ---
safeExport("getIncidentV1", "./getIncidentV1");
safeExport("listIncidentsV1", "./listIncidentsV1");
safeExport("backfillIncidentTitleV1", "./backfillIncidentTitleV1");
safeExport("createIncidentV1", "./createIncidentV1");
safeExport("getTimelineEventsV1", "./getTimelineEventsV1");
safeExport("getWorkflowV1", "./getWorkflowV1");
safeExport("generateTimelineV1", "./generateTimelineV1");
safeExport("generateFilingsV1", "./generateFilingsV1");
safeExport("getIncidentBundleV1", "./getIncidentBundleV1");
safeExport("listEvidenceLocker", "./listEvidenceLocker");
safeExport("closeIncidentV1", "./closeIncidentV1");

// --- Sessions ---
safeExport("markArrivedV1", "./markArrivedV1", "markArrivedV1");
safeExport("startFieldSessionV1", "./startFieldSessionV1");
safeExport("submitFieldSessionV1", "./submitFieldSessionV1");
// PEAKOPS_SLICE71_RESTORE_EXPORTS_V1 (2026-05-06)
// approveFieldSessionV1 is the supervisor's terminal sign-off
// counterpart to submitFieldSessionV1. addMaterialV1 is the
// field-side material-capture write that runs alongside
// addEvidenceV1 during a session. Both have role gates wired
// through _authz.js (Slices 4 / 5) but were never registered with
// the Functions runtime; smoke runs in earlier slices flagged them
// as unverifiable. Wiring them in unblocks Slice 8 rules alignment
// and gives both gates real deployment paths.
safeExport("approveFieldSessionV1", "./approveFieldSessionV1");
safeExport("addMaterialV1", "./addMaterialV1");

// --- Evidence ---
safeExport("addEvidenceV1", "./addEvidenceV1");
safeExport("createEvidenceUploadUrlV1", "./createEvidenceUploadUrlV1");
safeExport("createEvidenceReadUrlV1", "./createEvidenceReadUrlV1");
safeExport("uploadEvidenceProxyV1", "./uploadEvidenceProxyV1");

// --- Addenda (PR 43) ---
// Post-closure supplemental context. createAddendumV1 commits the
// record; createAddendumUploadUrlV1 mints a signed PUT URL for the
// optional single file attachment per addendum. listAddendaV1 (PR 44)
// is the read-side surface used by Summary.
safeExport("createAddendumV1", "./createAddendumV1");
safeExport("createAddendumUploadUrlV1", "./createAddendumUploadUrlV1");
safeExport("listAddendaV1", "./listAddendaV1");

// --- Jobs ---
  safeExport("createJobV1", "./createJobV1");
safeExport("listJobsV1", "./listJobsV1");
safeExport("getJobV1", "./getJobV1");
safeExport("updateJobStatusV1", "./updateJobStatusV1");
safeExport("updateJobNotesV1", "./updateJobNotesV1");
safeExport("markJobCompleteV1", "./markJobCompleteV1");
safeExport("getIncidentNotesV1", "./getIncidentNotesV1");
safeExport("saveIncidentNotesV1", "./saveIncidentNotesV1");
safeExport("assignEvidenceToJobV1", "./assignEvidenceToJobV1");
safeExport("backfillEvidenceJobIdV1", "./backfillEvidenceJobIdV1");
// PEAKOPS_SLICE9_VENDOR_ASSIGN_CALLABLE_V1 (2026-05-06)
// Replaces the direct-client setDoc that lib/jobVendor.ts used to
// run against incidents/{id}/jobs/{jobId}. Slice 8's narrow rules
// allowance for that path goes away alongside this export.
safeExport("assignVendorToJobV1", "./assignVendorToJobV1");

// --- HEIC / conversions ---
safeExport("convertEvidenceHeicNowV1", "./convertEvidenceHeicNowV1");
safeExport("convertHeicOnFinalize", "./convertHeicOnFinalize");

// --- Debug / org tools ---
safeExport("listOrgsV1", "./listOrgsV1");
// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119a, PR 125a)
// Admin-only template authoring callables. Trio powers the
// /admin/templates editor UI. saveOrgTemplateV1 bumps version on each
// save and appends to admin_audit; existing incidents keep their
// frozen requirements snapshot (PR 104/118 audit contract).
// getOrgTemplateV1 (PR 125a) is the editor's load path — returns the
// full doc on edit so reopening rehydrates arrays + reasons instead
// of falling back to the summary projection from listOrgTemplatesV1.
safeExport("listOrgTemplatesV1", "./listOrgTemplatesV1");
safeExport("getOrgTemplateV1", "./getOrgTemplateV1");
safeExport("saveOrgTemplateV1", "./saveOrgTemplateV1");
// PEAKOPS_LIST_ORG_MEMBERS_V1 (2026-05-18, PR 36)
// Read-only member directory endpoint. Returns minimal whitelisted
// identity fields to power the Summary page's actor resolver.
safeExport("listOrgMembersV1", "./listOrgMembersV1");
// PEAKOPS_SLICE14_BOOTSTRAP_PILOT_V1 (2026-05-06)
// Internal-staff-only callable that creates a customer org plus its
// owner member doc atomically. Production blocker §5.1 from the
// Production Readiness Plan.
safeExport("bootstrapPilotOrgV1", "./bootstrapPilotOrgV1");
safeExport("debugEvidenceV1", "./debugEvidenceV1");
safeExport("debugOrgsV1", "./debugOrgsV1");

// Evidence labels
safeExport("setEvidenceLabelV1", "./setEvidenceLabelV1");

// Approvals
safeExport("approveAndLockJobV1", "./approveAndLockJobV1");
safeExport("approveJobV1", "./approveJobV1");
safeExport("rejectJobV1", "./rejectJobV1");

// Exports
safeExport("exportIncidentPacketV1", "./exportIncidentPacketV1");
safeExport("getIncidentPacketMetaV1", "./getIncidentPacketMetaV1");
// PR 103a — Acceptance Readiness Engine
safeExport("getAcceptanceReadinessV1", "./getAcceptanceReadinessV1");

// Supervisor Requests
safeExport("createSupervisorRequestV1", "./createSupervisorRequestV1");

// Job org assignment
safeExport("assignJobOrgV1", "./assignJobOrgV1");
