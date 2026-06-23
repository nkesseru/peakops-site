// PEAKOPS_ENFORCEMENT_V1 (PR 133C, 2026-06-23)
//
// Validation-mode "block" enforcement for the three customer-shipping
// callables: exportIncidentPacketV1, createCustomerReviewLinkV1,
// mintResubmissionLinkV1.
//
// Blocking conditions (ALL OTHERS are warn-only or no-action):
//   1. DIRS ERROR-severity findings from runComplianceCheck
//      (dirs.entity.identification.required, dirs.geographic_area.required,
//      dirs.affected_population.required)
//   2. acceptanceReadiness.state === "requirements_missing"
//      (operator's own template required-proof items unsatisfied)
//
// Mode handling:
//   - mode != "block"  → action="allow" (PR 133C is a no-op)
//   - mode = "block" + no blocking conditions → action="allow"
//   - mode = "block" + blocking conditions present → action="block"
//                                                    overridable=true
//
// Override semantics:
//   - Owner or admin role only
//   - Requires body.acknowledgeViolations === true
//   - Requires body.violationAcknowledgmentReason length 20-500 chars
//   - Override is single-use per call (does NOT stick to the incident)
//
// Audit surface for override events (INTERNAL ONLY for PR 133C —
// per policy decision, override disclosures are NOT surfaced to the
// customer in packet README / customer summary / review response;
// the customer-visibility policy is deferred to a later PR after
// pilot feedback):
//   - orgs/{orgId}/audit/{auditId}     (compliance_block_triggered |
//                                       compliance_block_overridden)
//   - Cloud Logging structured event
//   - incidents/{incidentId}/timeline_events
//   - For override: packet-manifest.json compliance.override block
//     (exportIncidentPacketV1 only)

const { FieldValue } = require("firebase-admin/firestore");
const { readValidationMode } = require("./_readiness");
const { runComplianceCheck } = require("./_complianceValidator");

const VALIDATION_MODE_BLOCK = "block";
const OVERRIDE_REASON_MIN = 20;
const OVERRIDE_REASON_MAX = 500;
const ACCEPTANCE_BLOCK_CODE = "acceptance.requirements_missing";

function _evidenceTypesFromList(evidenceDocs) {
  if (!Array.isArray(evidenceDocs)) return [];
  const set = new Set();
  for (const ev of evidenceDocs) {
    const data = ev && (typeof ev.data === "function" ? ev.data() : ev) || {};
    const labels = Array.isArray(data.labels) ? data.labels : [];
    const single = data.type ? [data.type] : [];
    for (const raw of [...labels, ...single]) {
      const t = String(raw || "").trim().toUpperCase();
      if (t) set.add(t);
    }
  }
  return Array.from(set);
}

// Decide whether to block. Always safe to call — mode != "block"
// returns { action: "allow" } regardless of compliance findings.
async function evaluateEnforcement({ db, orgId, incident, evidenceTypes, acceptanceReadinessState }) {
  const mode = await readValidationMode(db, orgId);
  const compliance = runComplianceCheck(incident, Array.isArray(evidenceTypes) ? evidenceTypes : []);
  const errorIssues = (compliance.issues || []).filter((i) => i.severity === "ERROR");
  const acceptanceMissing = acceptanceReadinessState === "requirements_missing";

  const blocking = mode === VALIDATION_MODE_BLOCK && (errorIssues.length > 0 || acceptanceMissing);
  const codes = [
    ...errorIssues.map((i) => ({ code: i.code, severity: "ERROR", source: "dirs" })),
    ...(acceptanceMissing ? [{ code: ACCEPTANCE_BLOCK_CODE, severity: "ERROR", source: "acceptance" }] : []),
  ];

  return {
    mode,
    enforced: blocking,
    action: blocking ? "block" : "allow",
    overridable: blocking,
    codes,
    rulepackVersionsByType: compliance.rulepackVersionsByType || {},
  };
}

// Validate override fields from the request body. Returns
// { ok: true, reason } on success or { ok: false, status, error, detail }.
function parseOverride(body, actorRole) {
  const requested = !!(body && body.acknowledgeViolations === true);
  if (!requested) return { ok: false, status: 412, error: "override_required" };

  const isAdmin = actorRole === "owner" || actorRole === "admin";
  if (!isAdmin) {
    return {
      ok: false, status: 403, error: "override_role_required",
      detail: "Only owner or admin roles may acknowledge compliance violations.",
    };
  }

  const reason = String((body && body.violationAcknowledgmentReason) || "").trim();
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
    return {
      ok: false, status: 400, error: "override_reason_invalid",
      detail: `violationAcknowledgmentReason must be ${OVERRIDE_REASON_MIN}-${OVERRIDE_REASON_MAX} chars.`,
    };
  }
  return { ok: true, reason };
}

// Write audit + log + timeline for a block that fired (no override).
async function recordBlockTriggered({ db, orgId, incidentId, callable, evaluation, actorUid, actorRole }) {
  const auditId = `compliance_block_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const auditRef = db.doc(`orgs/${orgId}/audit/${auditId}`);
  const occurredAt = FieldValue.serverTimestamp();
  const payload = {
    id: auditId,
    type: "compliance_block_triggered",
    callable,
    orgId,
    incidentId,
    codes: evaluation.codes,
    rulepackVersionsByType: evaluation.rulepackVersionsByType,
    actorUid,
    actorRole,
    occurredAt,
  };
  await auditRef.set(payload).catch((e) => {
    console.warn(`[${callable}] enforcement_audit_failed`, { msg: String(e && e.message) });
  });
  console.log(`[${callable}] compliance_block_triggered`, {
    orgId, incidentId, codes: evaluation.codes, actorUid, actorRole,
  });
  await db.collection(`incidents/${incidentId}/timeline_events`).add({
    type: "compliance_block_triggered",
    callable,
    actor: actorUid,
    actorRole,
    codes: evaluation.codes,
    occurredAt,
  }).catch(() => {});
}

// Write audit + log + timeline for a successful override. Returns
// the override record the caller embeds into the packet manifest
// (exportIncidentPacketV1 only).
async function recordBlockOverridden({ db, orgId, incidentId, callable, evaluation, actorUid, actorRole, reason }) {
  const auditId = `compliance_override_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const auditRef = db.doc(`orgs/${orgId}/audit/${auditId}`);
  const occurredAt = FieldValue.serverTimestamp();
  const recordedAtIso = new Date().toISOString();
  const payload = {
    id: auditId,
    type: "compliance_block_overridden",
    callable,
    orgId,
    incidentId,
    codes: evaluation.codes,
    rulepackVersionsByType: evaluation.rulepackVersionsByType,
    acknowledgerUid: actorUid,
    acknowledgerRole: actorRole,
    reason,
    occurredAt,
  };
  await auditRef.set(payload).catch((e) => {
    console.warn(`[${callable}] enforcement_audit_failed`, { msg: String(e && e.message) });
  });
  console.log(`[${callable}] compliance_block_overridden`, {
    orgId, incidentId, codes: evaluation.codes,
    acknowledgerUid: actorUid, acknowledgerRole: actorRole, reasonLen: reason.length,
  });
  await db.collection(`incidents/${incidentId}/timeline_events`).add({
    type: "compliance_block_overridden",
    callable,
    actor: actorUid,
    actorRole,
    codes: evaluation.codes,
    reason,
    occurredAt,
  }).catch(() => {});
  return {
    auditId,
    acknowledgerUid: actorUid,
    acknowledgerRole: actorRole,
    reason,
    codes: evaluation.codes,
    rulepackVersionsByType: evaluation.rulepackVersionsByType,
    recordedAt: recordedAtIso,
  };
}

module.exports = {
  evaluateEnforcement,
  parseOverride,
  recordBlockTriggered,
  recordBlockOverridden,
  _evidenceTypesFromList,
  VALIDATION_MODE_BLOCK,
  OVERRIDE_REASON_MIN,
  OVERRIDE_REASON_MAX,
  ACCEPTANCE_BLOCK_CODE,
};
