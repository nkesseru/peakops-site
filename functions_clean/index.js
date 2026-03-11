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
safeExport("getTimelineEventsV1", "./getTimelineEventsV1");
safeExport("listEvidenceLocker", "./listEvidenceLocker");

// --- Sessions ---
safeExport("startFieldSessionV1", "./startFieldSessionV1");

// --- Evidence ---
safeExport("addEvidenceV1", "./addEvidenceV1");
safeExport("createEvidenceUploadUrlV1", "./createEvidenceUploadUrlV1");
safeExport("createEvidenceReadUrlV1", "./createEvidenceReadUrlV1");
safeExport("uploadEvidenceProxyV1", "./uploadEvidenceProxyV1");

// --- Jobs ---
  safeExport("createJobV1", "./createJobV1");
safeExport("listJobsV1", "./listJobsV1");
safeExport("getJobV1", "./getJobV1");
safeExport("updateJobStatusV1", "./updateJobStatusV1");
safeExport("getIncidentNotesV1", "./getIncidentNotesV1");
safeExport("saveIncidentNotesV1", "./saveIncidentNotesV1");
safeExport("assignEvidenceToJobV1", "./assignEvidenceToJobV1");
safeExport("backfillEvidenceJobIdV1", "./backfillEvidenceJobIdV1");

// --- HEIC / conversions ---
safeExport("convertEvidenceHeicNowV1", "./convertEvidenceHeicNowV1");
safeExport("convertHeicOnFinalize", "./convertHeicOnFinalize");

// --- Debug / org tools ---
safeExport("listOrgsV1", "./listOrgsV1");
safeExport("debugEvidenceV1", "./debugEvidenceV1");
safeExport("debugOrgsV1", "./debugOrgsV1");

// Evidence labels
safeExport("setEvidenceLabelV1", "./setEvidenceLabelV1");

// Approvals
safeExport("approveAndLockJobV1", "./approveAndLockJobV1");

// Exports
safeExport("exportIncidentPacketV1", "./exportIncidentPacketV1");

// Supervisor Requests
safeExport("createSupervisorRequestV1", "./createSupervisorRequestV1");

// Job org assignment
safeExport("assignJobOrgV1", "./assignJobOrgV1");
