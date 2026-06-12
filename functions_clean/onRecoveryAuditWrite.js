// PEAKOPS_RECOVERY_AUDIT_TRIGGER_V1 (PR 132b)
//
// Firestore trigger on every new audit row under
//   orgs/{orgId}/recovery_audit/{auditId}
//
// Dispatches the event to the three aggregator helpers
// (_recoveryAggregators.js). Each aggregator is idempotent and
// org-scoped; this trigger does not cross orgs.
//
// Architecture lock:
//   - Trigger-based per decision lock (no cron)
//   - At-least-once delivery: aggregators handle retries via
//     lastSeenAuditIds membership
//   - No throws: a single aggregator failure must NOT poison the
//     others or cause the event to be retried indefinitely. Each is
//     wrapped in try/catch.

require("./_emu_bootstrap");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const {
  aggregateRecoveryMetrics,
  aggregateCauseEffectiveness,
  aggregateActionEffectiveness,
  // PR 132c-a — fourth aggregator: per-templateKey rejection mix.
  aggregateTemplateGap,
} = require("./_recoveryAggregators");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

exports.onRecoveryAuditWrite = onDocumentCreated(
  "orgs/{orgId}/recovery_audit/{auditId}",
  async (event) => {
    const orgId = String(event.params?.orgId || "").trim();
    const auditId = String(event.params?.auditId || "").trim();
    if (!orgId || !auditId) return;

    const snap = event.data;
    const audit = (snap && typeof snap.data === "function") ? (snap.data() || {}) : {};
    if (!audit || !audit.type) return;

    // Run all four aggregators in parallel. Each is independent so
    // a failure in one shouldn't block the others. We deliberately
    // catch + log instead of letting the trigger retry — duplicates
    // are handled by the aggregator's idempotency check, but bad
    // event payloads would otherwise loop forever.
    const results = await Promise.all([
      aggregateRecoveryMetrics({ orgId, auditId, audit }).catch((e) => {
        console.error("[onRecoveryAuditWrite] recovery_metrics failed", { orgId, auditId, error: String(e?.message || e) });
        return false;
      }),
      aggregateCauseEffectiveness({ orgId, auditId, audit }).catch((e) => {
        console.error("[onRecoveryAuditWrite] cause_effectiveness failed", { orgId, auditId, error: String(e?.message || e) });
        return false;
      }),
      aggregateActionEffectiveness({ orgId, auditId, audit }).catch((e) => {
        console.error("[onRecoveryAuditWrite] action_effectiveness failed", { orgId, auditId, error: String(e?.message || e) });
        return false;
      }),
      aggregateTemplateGap({ orgId, auditId, audit }).catch((e) => {
        console.error("[onRecoveryAuditWrite] template_gap failed", { orgId, auditId, error: String(e?.message || e) });
        return false;
      }),
    ]);

    console.log("[onRecoveryAuditWrite] dispatched", {
      orgId, auditId,
      eventType: audit.type,
      applied: {
        metrics: results[0],
        cause: results[1],
        action: results[2],
        templateGap: results[3],
      },
    });
  }
);
