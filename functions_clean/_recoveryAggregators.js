// PEAKOPS_RECOVERY_AGGREGATORS_V1 (PR 132b)
//
// Pure aggregator functions called by the onRecoveryAuditWrite trigger
// (Cloud Function defined in onRecoveryAuditWrite.js). Each aggregator
// owns one or more docs under orgs/{orgId}/recovery_aggregates/{key}
// and idempotently updates them per audit event.
//
// Architecture lock (PR 132b decision lock 2026-06-08):
//   - Trigger-based (onDocumentCreated), NOT cron
//   - 3 aggregator types in this PR:
//       recovery_metrics
//       cause_effectiveness
//       action_effectiveness
//   - Daily buckets at write time; rolling window totals computed at
//     READ TIME (getRecoveryAggregatesV1) by summing buckets in
//     [now - windowDays, now]. Window is not stored; only the buckets
//     are. This means changing windows later requires no migration.
//   - Idempotency via lastSeenAuditIds (capped at 500 most-recent IDs)
//   - Org-scoped: hard line — no cross-org aggregates
//   - No PII: customer label aggregates deferred to PR 132c
//
// The trigger guarantees at-least-once delivery. Aggregators must
// safely handle retries: every aggregate doc carries an arrayUnion
// of audit IDs; a duplicate fire is a no-op.

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Cap so the lastSeenAuditIds field never balloons. We keep the most
// recent IDs — older audits are very unlikely to be retried. 500 is a
// rough ~hours-of-activity buffer for an active org.
const SEEN_AUDIT_IDS_CAP = 500;

// Per-aggregator doc IDs. Single doc per metric type for the daily
// bucket map; per-cause / per-action-type for the others.
function metricsDocId() { return "recovery_metrics"; }
function causeDocId(causePrimary) {
  return `cause_effectiveness_${String(causePrimary || "unknown").replace(/[^A-Za-z0-9_]/g, "_")}`;
}
function actionDocId(actionType) {
  return `action_effectiveness_${String(actionType || "unknown").replace(/[^A-Za-z0-9_]/g, "_")}`;
}
function templateGapDocId(templateKey) {
  return `template_gap_${String(templateKey || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

// Convert an event timestamp (Firestore Timestamp or ISO string) to
// the YYYY-MM-DD UTC bucket key.
function bucketKeyFromCreatedAt(createdAt) {
  if (!createdAt) return null;
  let d = null;
  if (typeof createdAt?.toDate === "function") {
    try { d = createdAt.toDate(); } catch { /* fallthrough */ }
  } else if (typeof createdAt === "string") {
    const t = Date.parse(createdAt);
    if (!Number.isNaN(t)) d = new Date(t);
  } else if (typeof createdAt?._seconds === "number") {
    d = new Date(createdAt._seconds * 1000);
  } else if (createdAt instanceof Date) {
    d = createdAt;
  }
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

// Add two daily-bucket payloads (a + b) into a single object. Used by
// the read-side window summarizer in getRecoveryAggregatesV1.
function addBuckets(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) {
    if (typeof b[k] === "number" && Number.isFinite(b[k])) {
      out[k] = (Number(out[k]) || 0) + b[k];
    } else if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      // Nested histograms (e.g. resubmissionCountHistogram)
      out[k] = { ...(out[k] || {}) };
      for (const sk of Object.keys(b[k])) {
        if (typeof b[k][sk] === "number") {
          out[k][sk] = (Number(out[k][sk]) || 0) + b[k][sk];
        }
      }
    }
  }
  return out;
}

/**
 * Atomically apply a daily-bucket delta + idempotency tracking to an
 * aggregate doc. Returns true if applied, false if skipped (duplicate).
 *
 * @param {object} args
 * @param {FirebaseFirestore.DocumentReference} args.docRef
 * @param {string} args.auditId
 * @param {string} args.eventType
 * @param {string} args.bucketKey         "YYYY-MM-DD"
 * @param {object} args.bucketDelta       { casesOpened: 1, totalRevenueOpened: 5000, ... }
 * @param {object} [args.lifetimeDelta]   same shape; applied to lifetime totals
 * @param {object} [args.docSeed]         additional fields to set on first write
 * @returns {Promise<boolean>}
 */
async function applyAggregateDelta({
  docRef, auditId, eventType, bucketKey, bucketDelta, lifetimeDelta, docSeed,
}) {
  if (!bucketKey) return false;
  const db = getFirestore();
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.exists ? (snap.data() || {}) : {};
    const seen = Array.isArray(data.lastSeenAuditIds) ? data.lastSeenAuditIds : [];
    if (seen.includes(auditId)) return false;

    const dailyBefore = (data.daily && typeof data.daily === "object") ? data.daily : {};
    const dayBefore = dailyBefore[bucketKey] || {};
    const dayAfter = addBuckets(dayBefore, bucketDelta);

    const lifetimeBefore = (data.lifetime && typeof data.lifetime === "object") ? data.lifetime : {};
    const lifetimeAfter = lifetimeDelta ? addBuckets(lifetimeBefore, lifetimeDelta) : lifetimeBefore;

    const nextSeen = [auditId, ...seen].slice(0, SEEN_AUDIT_IDS_CAP);

    tx.set(docRef, {
      ...(docSeed || {}),
      ...data,
      daily: { ...dailyBefore, [bucketKey]: dayAfter },
      lifetime: lifetimeAfter,
      lastSeenAuditIds: nextSeen,
      lastEventAt: data.lastEventAt || null,  // updated below to keep type uniform
      lastEventType: eventType,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // Update lastEventAt to now (writeTime) by separate set so the
    // serverTimestamp resolves correctly with merge.
    tx.set(docRef, { lastEventAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

// ── 1. recovery_metrics aggregator ────────────────────────────────
// One doc per org. Daily buckets store the per-day metric deltas;
// lifetime stores all-time totals. The read endpoint sums buckets
// within the requested window for the rolling-window view.
async function aggregateRecoveryMetrics({ orgId, auditId, audit }) {
  const eventType = String(audit.type || "");
  const bucketKey = bucketKeyFromCreatedAt(audit.createdAt);
  if (!bucketKey) return false;

  const db = getFirestore();
  const docRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates").doc(metricsDocId());

  const meta = audit.meta || {};
  let delta = null;
  let lifetime = null;

  if (eventType === "case_opened" || eventType === "case_auto_opened_from_rejection") {
    delta = { casesOpened: 1 };
    lifetime = { casesOpened: 1 };
  } else if (eventType === "case_resolved") {
    const outcome = String(meta.outcome || "");
    delta = { caseResolutions: 1 };
    lifetime = { caseResolutions: 1 };
    if (outcome === "recovered") {
      delta.casesRecovered = 1;
      lifetime.casesRecovered = 1;
    } else if (outcome === "partial_recovery") {
      delta.casesPartialRecovery = 1;
      lifetime.casesPartialRecovery = 1;
    } else if (outcome === "abandoned") {
      delta.casesAbandoned = 1;
      lifetime.casesAbandoned = 1;
    } else if (outcome === "expired") {
      delta.casesExpired = 1;
      lifetime.casesExpired = 1;
    }
    const t = Number(meta.timeToResolutionSec);
    if (Number.isFinite(t) && t >= 0) {
      delta.totalRecoveryDurationSec = t;
      delta.recoveryDurationSamples = 1;
      lifetime.totalRecoveryDurationSec = t;
      lifetime.recoveryDurationSamples = 1;
    }
    const r = Number(meta.totalResubmissions);
    if (Number.isFinite(r) && r >= 0) {
      delta.resubmissionCountHistogram = { [String(r)]: 1 };
      lifetime.resubmissionCountHistogram = { [String(r)]: 1 };
    }
  } else if (eventType === "revenue_recovered") {
    const rar = meta.revenueAtRisk || {};
    const amt = Number(rar.amount);
    const finalAmt = Number(meta.finalAmount);
    const recovered = Number.isFinite(finalAmt) && finalAmt > 0 ? finalAmt : (Number.isFinite(amt) ? amt : 0);
    if (recovered > 0) {
      delta = { totalRevenueRecovered: recovered };
      lifetime = { totalRevenueRecovered: recovered };
    }
  } else {
    return false;
  }

  if (!delta) return false;
  return await applyAggregateDelta({
    docRef, auditId, eventType, bucketKey,
    bucketDelta: delta,
    lifetimeDelta: lifetime,
    docSeed: { orgId, viewType: "recovery_metrics" },
  });
}

// ── 2. cause_effectiveness aggregator ─────────────────────────────
// One doc per cause primary per org. Cause is read from the case doc
// at trigger time so resolution events get attributed to the current
// cause (not whatever the auto-open inferred).
async function aggregateCauseEffectiveness({ orgId, auditId, audit }) {
  const eventType = String(audit.type || "");
  const bucketKey = bucketKeyFromCreatedAt(audit.createdAt);
  if (!bucketKey) return false;
  const caseId = String(audit.caseId || "");
  if (!caseId) return false;

  const db = getFirestore();
  const meta = audit.meta || {};

  // Resolve the cause attribution for this event. For
  // case_auto_opened_from_rejection we use meta.inferredCause (the
  // value at creation time). For everything else we look up the case
  // doc's current cause.primary.
  let causePrimary = "";
  if (eventType === "case_auto_opened_from_rejection") {
    causePrimary = String(meta.inferredCause || "").trim();
    // No inference → no cause aggregate update (we can't attribute it).
    if (!causePrimary) return false;
  } else {
    try {
      const caseSnap = await db.doc(`orgs/${orgId}/recovery_cases/${caseId}`).get();
      if (!caseSnap.exists) return false;
      causePrimary = String((caseSnap.data() || {}).cause?.primary || "").trim();
    } catch (e) {
      console.warn("[aggregateCauseEffectiveness] case read failed", e && e.message);
      return false;
    }
    if (!causePrimary) return false;
  }

  let delta = null;
  let lifetime = null;
  if (eventType === "case_auto_opened_from_rejection") {
    delta = { totalCases: 1 };
    lifetime = { totalCases: 1 };
  } else if (eventType === "case_opened") {
    // Manual-create cases also count if a cause was supplied.
    delta = { totalCases: 1 };
    lifetime = { totalCases: 1 };
  } else if (eventType === "case_resolved") {
    delta = { caseResolutions: 1 };
    lifetime = { caseResolutions: 1 };
    const outcome = String(meta.outcome || "");
    if (outcome === "recovered") {
      delta.casesRecovered = 1;
      lifetime.casesRecovered = 1;
    } else if (outcome === "abandoned") {
      delta.casesAbandoned = 1;
      lifetime.casesAbandoned = 1;
    }
    const t = Number(meta.timeToResolutionSec);
    if (Number.isFinite(t) && t >= 0) {
      delta.totalRecoveryDurationSec = t;
      delta.recoveryDurationSamples = 1;
      lifetime.totalRecoveryDurationSec = t;
      lifetime.recoveryDurationSamples = 1;
    }
    const r = Number(meta.totalResubmissions);
    if (Number.isFinite(r) && r >= 0) {
      delta.totalResubmissions = r;
      delta.resubmissionSamples = 1;
      lifetime.totalResubmissions = r;
      lifetime.resubmissionSamples = 1;
    }
  } else if (eventType === "revenue_recovered") {
    const rar = meta.revenueAtRisk || {};
    const amt = Number(rar.amount);
    const finalAmt = Number(meta.finalAmount);
    const recovered = Number.isFinite(finalAmt) && finalAmt > 0 ? finalAmt : (Number.isFinite(amt) ? amt : 0);
    if (recovered > 0) {
      delta = { totalRevenueRecovered: recovered };
      lifetime = { totalRevenueRecovered: recovered };
    }
  } else if (eventType === "cause_overridden") {
    // PR 132a — operator changed cause. If the prior was inferred,
    // count this as an inference-miss for the FROM cause; the TO cause
    // gets no implicit count (the new cause's "totalCases" was
    // already counted when the case opened).
    if (meta.originallyInferred === true) {
      const fromCause = String((audit.before || {}).causePrimary || "").trim();
      if (fromCause) {
        const fromRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates").doc(causeDocId(fromCause));
        await applyAggregateDelta({
          docRef: fromRef, auditId, eventType, bucketKey,
          bucketDelta: { inferenceOverrides: 1 },
          lifetimeDelta: { inferenceOverrides: 1 },
          docSeed: { orgId, viewType: "cause_effectiveness", causePrimary: fromCause },
        });
      }
    }
    return true;
  }

  if (!delta) return false;
  const docRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates").doc(causeDocId(causePrimary));
  return await applyAggregateDelta({
    docRef, auditId, eventType, bucketKey,
    bucketDelta: delta,
    lifetimeDelta: lifetime,
    docSeed: { orgId, viewType: "cause_effectiveness", causePrimary },
  });
}

// ── 3. action_effectiveness aggregator ────────────────────────────
// One doc per action type per org. Fed by action_completed audit
// events (which carry meta.actionType + meta.timeToCompleteSec +
// meta.evidenceAttachedCount in PR 132a's enrichments).
async function aggregateActionEffectiveness({ orgId, auditId, audit }) {
  const eventType = String(audit.type || "");
  if (eventType !== "action_completed") return false;
  const bucketKey = bucketKeyFromCreatedAt(audit.createdAt);
  if (!bucketKey) return false;

  const meta = audit.meta || {};
  const actionType = String(meta.actionType || "").trim();
  if (!actionType) {
    // Pre-PR-132a audit rows don't carry actionType — silently skip;
    // they're rare and not worth a follow-up read here.
    return false;
  }

  const delta = { totalUses: 1 };
  const lifetime = { totalUses: 1 };
  const t = Number(meta.timeToCompleteSec);
  if (Number.isFinite(t) && t >= 0) {
    delta.totalTimeToCompleteSec = t;
    delta.timeSamples = 1;
    lifetime.totalTimeToCompleteSec = t;
    lifetime.timeSamples = 1;
  }
  const ev = Number(meta.evidenceAttachedCount);
  if (Number.isFinite(ev) && ev >= 0) {
    delta.totalEvidenceAttached = ev;
    delta.evidenceSamples = 1;
    if (ev > 0) {
      delta.usesWithEvidence = 1;
      lifetime.usesWithEvidence = 1;
    }
    lifetime.totalEvidenceAttached = ev;
    lifetime.evidenceSamples = 1;
  }

  const db = getFirestore();
  const docRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates").doc(actionDocId(actionType));
  return await applyAggregateDelta({
    docRef, auditId, eventType, bucketKey,
    bucketDelta: delta,
    lifetimeDelta: lifetime,
    docSeed: { orgId, viewType: "action_effectiveness", actionType },
  });
}

// ── read helper for getRecoveryAggregatesV1 ───────────────────────
// ── 4. template_gap aggregator (PR 132c-a) ────────────────────────
// One doc per templateKey (cross-version per decision lock — the
// admin thinks in template families, not specific revisions). Tracks
// rejections + per-cause mix + per-version mix + outcome split.
//
// Surface (PR 132c-b): Template Editor renders a "Potential Revenue
// Protection Opportunity" inline strip when rejections in the
// 30-day window cross the threshold (3).
//
// Causes considered "template gaps" (recommendation copy in UI):
//   missing_required_proof, missing_test_result,
//   proof_quality_insufficient, wrong_proof_uploaded,
//   documentation_error, compliance_failure
// Other causes (scope_dispute, customer_changed_requirements, etc.)
// show count only; the UI gates the recommendation copy.
async function aggregateTemplateGap({ orgId, auditId, audit }) {
  const eventType = String(audit.type || "");
  const bucketKey = bucketKeyFromCreatedAt(audit.createdAt);
  if (!bucketKey) return false;
  const caseId = String(audit.caseId || "");
  if (!caseId) return false;

  const db = getFirestore();
  const meta = audit.meta || {};

  // Resolve templateKey + templateVersion from the case doc. Both
  // are written by createRecoveryCaseV1 / _recoveryAutoCreate when
  // the incident has them; null for older / incomplete cases.
  let templateKey = "";
  let templateVersion = null;
  try {
    const caseSnap = await db.doc(`orgs/${orgId}/recovery_cases/${caseId}`).get();
    if (!caseSnap.exists) return false;
    const caseData = caseSnap.data() || {};
    templateKey = String(caseData.templateKey || "").trim();
    if (Number.isFinite(Number(caseData.templateVersion))) {
      templateVersion = Number(caseData.templateVersion);
    }
  } catch (e) {
    console.warn("[aggregateTemplateGap] case read failed", e && e.message);
    return false;
  }
  // No templateKey on the case → nothing to attribute. Common for
  // legacy cases prior to PR 127c-a's denorm.
  if (!templateKey) return false;

  let delta = null;
  let lifetime = null;
  const versionKey = templateVersion != null ? `v${templateVersion}` : "vUnknown";

  if (eventType === "case_auto_opened_from_rejection" || eventType === "case_opened") {
    // A new rejection (or manual case open) lands on this template.
    // For auto-opened cases, prefer meta.inferredCause (the cause
    // attributed at create-time). For manual opens, the cause may
    // have been provided in the create call; fall back to "unknown"
    // when absent.
    let causePrimary = "";
    if (eventType === "case_auto_opened_from_rejection") {
      causePrimary = String(meta.inferredCause || "unknown").trim() || "unknown";
    } else {
      // case_opened doesn't carry cause in meta today; we re-read the
      // case doc's cause.primary (already loaded above? we only read
      // templateKey/version; do an extra read here).
      try {
        const cs = await db.doc(`orgs/${orgId}/recovery_cases/${caseId}`).get();
        causePrimary = String((cs.data() || {}).cause?.primary || "unknown").trim() || "unknown";
      } catch { causePrimary = "unknown"; }
    }
    delta = {
      rejections: 1,
      causeMix: { [causePrimary]: 1 },
      versionMix: { [versionKey]: 1 },
    };
    lifetime = {
      rejections: 1,
      causeMix: { [causePrimary]: 1 },
      versionMix: { [versionKey]: 1 },
    };
  } else if (eventType === "case_resolved") {
    const outcome = String(meta.outcome || "");
    delta = { caseResolutions: 1 };
    lifetime = { caseResolutions: 1 };
    if (outcome === "recovered") {
      delta.recoveredCount = 1;
      lifetime.recoveredCount = 1;
    } else if (outcome === "abandoned") {
      delta.abandonedCount = 1;
      lifetime.abandonedCount = 1;
    } else if (outcome === "partial_recovery") {
      delta.partialRecoveryCount = 1;
      lifetime.partialRecoveryCount = 1;
    }
    const t = Number(meta.timeToResolutionSec);
    if (Number.isFinite(t) && t >= 0) {
      delta.totalRecoveryDurationSec = t;
      delta.recoveryDurationSamples = 1;
      lifetime.totalRecoveryDurationSec = t;
      lifetime.recoveryDurationSamples = 1;
    }
  } else if (eventType === "revenue_recovered") {
    const rar = meta.revenueAtRisk || {};
    const amt = Number(rar.amount);
    const finalAmt = Number(meta.finalAmount);
    const recovered = Number.isFinite(finalAmt) && finalAmt > 0 ? finalAmt : (Number.isFinite(amt) ? amt : 0);
    if (recovered > 0) {
      delta = { totalRevenueRecovered: recovered };
      lifetime = { totalRevenueRecovered: recovered };
    }
  } else {
    return false;
  }

  if (!delta) return false;
  const docRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates").doc(templateGapDocId(templateKey));
  return await applyAggregateDelta({
    docRef, auditId, eventType, bucketKey,
    bucketDelta: delta,
    lifetimeDelta: lifetime,
    docSeed: {
      orgId,
      viewType: "template_gap",
      templateKey,
    },
  });
}

/**
 * Sum the daily buckets within the rolling window
 * [now - windowDays, now] and return a flat metrics object.
 *
 * @param {object} doc            the raw aggregate doc data
 * @param {number} windowDays
 * @returns {{ windowStart: string, windowEnd: string, metrics: object, samplesInWindow: number }}
 */
function summarizeWindow(doc, windowDays) {
  const daily = (doc && typeof doc.daily === "object") ? doc.daily : {};
  const now = new Date();
  const endMs = now.getTime();
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1000;
  const startKey = new Date(startMs).toISOString().slice(0, 10);
  const endKey = new Date(endMs).toISOString().slice(0, 10);

  let metrics = {};
  let samplesInWindow = 0;
  for (const key of Object.keys(daily)) {
    if (key >= startKey && key <= endKey) {
      metrics = addBuckets(metrics, daily[key]);
      samplesInWindow += 1;
    }
  }
  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: now.toISOString(),
    windowDays,
    metrics,
    samplesInWindow,
  };
}

module.exports = {
  aggregateRecoveryMetrics,
  aggregateCauseEffectiveness,
  aggregateActionEffectiveness,
  // PR 132c-a — template_gap aggregator powers the Template Editor
  // "Potential Revenue Protection Opportunity" surface (PR 132c-b).
  aggregateTemplateGap,
  summarizeWindow,
  // exported for the read endpoint to know which doc IDs to query
  metricsDocId,
  causeDocId,
  actionDocId,
  templateGapDocId,
  bucketKeyFromCreatedAt,
};
