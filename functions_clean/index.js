const { onRequest } = require("firebase-functions/v2/https");

function pick(mod) {
  // allow: module.exports = fn OR exports.default = fn OR named export
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (typeof mod.default === "function") return mod.default;
  // first function export
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") return mod[k];
  }
  return null;
}

const getContractsV1 = pick(require("./dist/getContractsV1.cjs"));
const getContractV1 = pick(require("./dist/getContractV1.cjs"));
const getContractPayloadsV1 = pick(require("./dist/getContractPayloadsV1.cjs"));
const writeContractPayloadV1 = pick(require("./dist/writeContractPayloadV1.cjs"));
const exportContractPacketV1 = pick(require("./dist/exportContractPacketV1.cjs"));

if (!getContractsV1 || !getContractV1 || !getContractPayloadsV1 || !writeContractPayloadV1 || !exportContractPacketV1) {
  throw new Error("functions_clean index.js: could not resolve one or more handlers");
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_clean" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
exports.exportContractPacketV1 = onRequest(exportContractPacketV1);

// Phase 2
exports.getWorkflowV1 = require("./getWorkflowV1").getWorkflowV1;
exports.startFieldSessionV1 = require("./startFieldSessionV1").startFieldSessionV1;
exports.markArrivedV1 = require("./markArrivedV1").markArrivedV1;
exports.addEvidenceV1 = require("./addEvidenceV1").addEvidenceV1;

/* --- Timeline Events API --- */
const { getTimelineEventsV1 } = require("./getTimelineEventsV1");
const { generateTimelineV1 } = require("./generateTimelineV1");

exports.getTimelineEventsV1 = getTimelineEventsV1;
// alias (what Next proxy will call)
exports.getTimelineEvents = getTimelineEventsV1;

exports.generateFilingsV1 = require('./generateFilingsV1').generateFilingsV1;

exports.exportIncidentPacketV1 = require('./exportIncidentPacketV1').exportIncidentPacketV1;
exports.getIncidentV1 = require("./getIncidentV1").getIncidentV1;

// --- Incident bundle (Phase 2)
exports.getIncidentBundleV1 = require("./getIncidentBundleV1").getIncidentBundleV1;

// --- DIRS generator (Phase 2)
exports.generateDIRSV1 = require("./generateDIRSV1").generateDIRSV1;

exports.generateTimelineV1 = generateTimelineV1;

exports.getIncidentPacketMetaV1 = require("./getIncidentPacketMetaV1").getIncidentPacketMetaV1;

exports.listEvidenceLocker = require("./listEvidenceLocker").listEvidenceLocker;
exports.getIncidentNotesV1 = require("./getIncidentNotesV1").getIncidentNotesV1;
exports.saveIncidentNotesV1 = require("./saveIncidentNotesV1").saveIncidentNotesV1;

exports.addMaterialV1 = require("./addMaterialV1").addMaterialV1;

exports.submitFieldSessionV1 = require("./submitFieldSessionV1").submitFieldSessionV1;

exports.approveFieldSessionV1 = require("./approveFieldSessionV1").approveFieldSessionV1;

exports.debugEmitTimelineV1 = require("./debugEmitTimelineV1").debugEmitTimelineV1;

exports.createEvidenceUploadUrlV1 = require("./createEvidenceUploadUrlV1").createEvidenceUploadUrlV1;
exports.uploadEvidenceProxyV1 = require("./uploadEvidenceProxyV1").uploadEvidenceProxyV1;
exports.createEvidenceReadUrlV1 = require("./createEvidenceReadUrlV1").createEvidenceReadUrlV1;
exports.convertHeicOnFinalize = require("./convertHeicOnFinalize").convertHeicOnFinalize;
exports.convertEvidenceHeicNowV1 = require("./convertEvidenceHeicNowV1").convertEvidenceHeicNowV1;
exports.runConversionJobsV1 = require("./runConversionJobsV1").runConversionJobsV1;
exports.debugHeicConversionV1 = require("./debugHeicConversionV1").debugHeicConversionV1;
exports.getEvidenceDebugV1 = require("./getEvidenceDebugV1").getEvidenceDebugV1;
