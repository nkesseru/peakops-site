// PEAKOPS_CAPTURE_GATE_V1 (PR 135A, 2026-06-26)
//
// Server-side enforcement that a field tech cannot SUBMIT a session
// or MARK A JOB COMPLETE without the required evidence captured.
//
// Mirrors the PR 133C `_enforcement.js` shape exactly — same audit
// pattern, same single-use admin override, same per-org config-mode
// model — because that shape is verified live and stable. This is
// the second instance of the same pattern, applied at a different
// boundary (field-side instead of customer-shipping side).
//
// Architecture:
//   1. Evaluator: evaluateCaptureGate({ db, orgId, incident, evidence, jobs })
//      → { mode, action: "allow" | "block", missing: [{key, label, detail}], overridable }
//      Pure function over the incident's persisted state. Uses the
//      existing computeAcceptanceReadiness engine (same evaluator
//      surface readinessCache populates from), filters to tier="required"
//      checks that are unsatisfied, and emits the operator-facing
//      missing[] payload.
//   2. Mode source: orgs/{orgId}/config/captureGate document.
//      - "block"        — refuse the call on requirements missing
//      - "passive_log"  — log the would-block decision, allow the call
//                         (advisory — used for existing orgs without
//                         the explicit config doc; per directive,
//                         absent-config defaults to passive_log)
//      - "off"          — skip the gate entirely
//   3. Override: admin/owner only. Body must include
//      acknowledgeCaptureGap: true + captureGapReason (20-500 chars).
//      Single-use per call (does NOT persist to the incident).
//   4. Audit: capture_gate_blocked (when gate fires + no override)
//      or capture_gate_overridden (when admin bypasses). Written to
//      orgs/{orgId}/audit via Admin SDK; firestore.rules audit-
//      immutability rule (2026-06-24) ensures these are append-only
//      from clients.

const { FieldValue } = require("firebase-admin/firestore");
const { computeAcceptanceReadiness } = require("./_readiness");

const CAPTURE_GATE_MODE_OFF = "off";
const CAPTURE_GATE_MODE_PASSIVE_LOG = "passive_log";
const CAPTURE_GATE_MODE_BLOCK = "block";
const VALID_MODES = new Set([CAPTURE_GATE_MODE_OFF, CAPTURE_GATE_MODE_PASSIVE_LOG, CAPTURE_GATE_MODE_BLOCK]);

const OVERRIDE_REASON_MIN = 20;
const OVERRIDE_REASON_MAX = 500;

// PR 135A semantic fix — only check things the field tech actually
// controls at session-submit / job-complete time. Supervisor-approval
// and incident-closure are downstream lifecycle checks that CANNOT be
// satisfied at the field boundary; gating on them would prevent every
// lifecycle from advancing. Adding a new check-type that the field
// controls means whitelisting its key here.
function isCaptureRelevantCheck(check) {
  const key = String((check && check.key) || "");
  return (
    key.startsWith("template_check__min_proof_") ||
    key === "template_check__one_gps_proof" ||
    key === "template_check__field_notes"
  );
}

// In-memory mode cache mirrors readValidationMode (_readiness.js): 60s
// TTL is plenty for kill-switch safety without hammering the config
// doc on every gated callable invocation.
const __captureGateModeCache = new Map();
const CAPTURE_GATE_TTL_MS = 60_000;

/**
 * Read the org's capture-gate mode. Absent doc OR unrecognized mode
 * value → "passive_log" (per the safe-by-default directive that
 * existing orgs without an explicit config keep advisory behavior).
 */
async function readCaptureGateMode(db, orgId) {
  const now = Date.now();
  const cached = __captureGateModeCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.mode;
  let mode = CAPTURE_GATE_MODE_PASSIVE_LOG;
  try {
    const cfg = await db.doc(`orgs/${orgId}/config/captureGate`).get();
    if (cfg.exists) {
      const raw = String((cfg.data() || {}).mode || "").trim().toLowerCase();
      if (VALID_MODES.has(raw)) mode = raw;
    }
  } catch (_e) {
    mode = CAPTURE_GATE_MODE_PASSIVE_LOG;
  }
  __captureGateModeCache.set(orgId, { mode, expiresAt: now + CAPTURE_GATE_TTL_MS });
  return mode;
}

function __resetCaptureGateModeCacheForTests() {
  __captureGateModeCache.clear();
}

/**
 * Evaluate the gate against an incident. Pure-ish — does Firestore
 * reads of the validation mode + computes the acceptance readiness.
 *
 * Returns:
 *   {
 *     mode: "off" | "passive_log" | "block",
 *     enforced: boolean,             // true only when mode=block AND requirements_missing
 *     action: "allow" | "block",
 *     overridable: boolean,
 *     missing: [{key, label, tier, detail}],
 *     readiness: {state, summary, ...}  // full computeAcceptanceReadiness output
 *   }
 */
async function evaluateCaptureGate({ db, orgId, incident, evidence, jobs }) {
  const mode = await readCaptureGateMode(db, orgId);
  const readiness = computeAcceptanceReadiness({
    incident: incident || {},
    evidence: Array.isArray(evidence) ? evidence : [],
    jobs: Array.isArray(jobs) ? jobs : [],
  });
  const missingChecks = (readiness.checks || [])
    .filter((c) => c.tier === "required" && c.satisfied === false && isCaptureRelevantCheck(c))
    .map((c) => ({
      key: c.key,
      label: c.label,
      tier: c.tier,
      detail: c.detail || null,
    }));
  // PR 135A semantic fix — we DO NOT use readiness.state directly
  // because that aggregates downstream lifecycle checks (supervisor
  // approval, incident closure) that can't be satisfied at the field
  // boundary. The capture gate fires only when at least one
  // capture-relevant required check is unsatisfied.
  const requirementsMissing = missingChecks.length > 0;
  const enforced = mode === CAPTURE_GATE_MODE_BLOCK && requirementsMissing;
  return {
    mode,
    enforced,
    action: enforced ? "block" : "allow",
    overridable: enforced,
    missing: missingChecks,
    readiness: {
      state: readiness.state,
      summary: readiness.summary,
    },
  };
}

/**
 * Validate override fields from the request body.
 * Returns { ok: true, reason } on success or { ok: false, status, error, detail }.
 */
function parseOverride(body, actorRole) {
  const requested = !!(body && body.acknowledgeCaptureGap === true);
  if (!requested) return { ok: false, status: 412, error: "override_required" };
  const isAdmin = actorRole === "owner" || actorRole === "admin";
  if (!isAdmin) {
    return {
      ok: false, status: 403, error: "override_role_required",
      detail: "Only owner or admin roles may bypass the capture gate.",
    };
  }
  const reason = String((body && body.captureGapReason) || "").trim();
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
    return {
      ok: false, status: 400, error: "override_reason_invalid",
      detail: `captureGapReason must be ${OVERRIDE_REASON_MIN}-${OVERRIDE_REASON_MAX} chars.`,
    };
  }
  return { ok: true, reason };
}

async function recordCaptureGateBlocked({ db, orgId, incidentId, callable, evaluation, actorUid, actorRole }) {
  const auditId = `capture_gate_blocked_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const ref = db.doc(`orgs/${orgId}/audit/${auditId}`);
  const occurredAt = FieldValue.serverTimestamp();
  await ref.set({
    id: auditId,
    type: "capture_gate_blocked",
    callable,
    orgId,
    incidentId,
    mode: evaluation.mode,
    missing: evaluation.missing,
    readinessState: evaluation.readiness?.state || null,
    actorUid,
    actorRole,
    occurredAt,
  }).catch((e) => {
    console.warn(`[${callable}] capture_gate_audit_failed`, { msg: String(e && e.message) });
  });
  console.log(`[${callable}] capture_gate_blocked`, {
    orgId, incidentId, missingCount: evaluation.missing.length, actorUid, actorRole,
  });
  await db.collection(`incidents/${incidentId}/timeline_events`).add({
    type: "capture_gate_blocked",
    callable,
    actor: actorUid,
    actorRole,
    missing: evaluation.missing,
    occurredAt,
  }).catch(() => {});
}

async function recordCaptureGateOverridden({ db, orgId, incidentId, callable, evaluation, actorUid, actorRole, reason }) {
  const auditId = `capture_gate_overridden_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const ref = db.doc(`orgs/${orgId}/audit/${auditId}`);
  const occurredAt = FieldValue.serverTimestamp();
  await ref.set({
    id: auditId,
    type: "capture_gate_overridden",
    callable,
    orgId,
    incidentId,
    mode: evaluation.mode,
    missing: evaluation.missing,
    readinessState: evaluation.readiness?.state || null,
    acknowledgerUid: actorUid,
    acknowledgerRole: actorRole,
    reason,
    occurredAt,
  }).catch((e) => {
    console.warn(`[${callable}] capture_gate_audit_failed`, { msg: String(e && e.message) });
  });
  console.log(`[${callable}] capture_gate_overridden`, {
    orgId, incidentId, missingCount: evaluation.missing.length,
    acknowledgerUid: actorUid, acknowledgerRole: actorRole, reasonLen: reason.length,
  });
  await db.collection(`incidents/${incidentId}/timeline_events`).add({
    type: "capture_gate_overridden",
    callable,
    actor: actorUid,
    actorRole,
    missing: evaluation.missing,
    reason,
    occurredAt,
  }).catch(() => {});
}

module.exports = {
  evaluateCaptureGate,
  parseOverride,
  recordCaptureGateBlocked,
  recordCaptureGateOverridden,
  readCaptureGateMode,
  __resetCaptureGateModeCacheForTests,
  CAPTURE_GATE_MODE_OFF,
  CAPTURE_GATE_MODE_PASSIVE_LOG,
  CAPTURE_GATE_MODE_BLOCK,
  OVERRIDE_REASON_MIN,
  OVERRIDE_REASON_MAX,
};
