// PEAKOPS_COMPLIANCE_VALIDATOR_JS_V1 (PR 133B)
//
// JavaScript twin of the TypeScript validation engine at:
//   - validation/engine.ts
//   - validation/rulepacks/executor.ts
//   - validation/rulepacks/getByDotPath.ts
//   - validation/crossField.ts
//   - validation/evidence.ts
//   - validation/_realityAdapter.ts
//
// Why a twin: the TS engine cannot run inside Cloud Functions today.
// The Cloud Functions deploy pipeline only ships CommonJS JavaScript
// from `functions_clean/`. The TS engine is consumed by:
//   - `filing/generatePackage.ts` (called by archived legacy function)
//   - test harnesses (`validation/testHarness.ts`)
//
// This twin preserves byte-identical behavior for every code path
// exercised by the engine on real production data. A Day 2 differential
// test (see PR 133B plan) compares both engines against the same
// 5-incident fixture before any deploy.
//
// HARD RULE: this file must NOT diverge from the TS engine in
// observable behavior. When the TS source changes, this file must be
// updated in the same PR. The reverse is also true. If divergence is
// ever needed, add a clearly-marked comment block explaining why.
//
// Architecture lock (PR 133B):
//   - Passive validation only. This module is invoked from
//     `_readiness.js` inside `refreshReadinessCache`, gated by an
//     org-level config flag.
//   - No export-path invocation in this PR.
//   - No new rulepacks (the rulepack JSON files in
//     `_complianceRulepacks/` are byte-copies of
//     `contracts/rulepacks/*/v1.json`).

// ── PORTED FROM validation/rulepacks/getByDotPath.ts ───────────────
function getByDotPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// ── PORTED FROM validation/_realityAdapter.ts ──────────────────────
//
// Maps any-case PeakOps lifecycle status (lowercase production values)
// to the regulatory lifecycle the rulepacks reason about (UPPERCASE).
// Empty string when the raw value can't be mapped — lets the WHEN
// gate fail closed (rule doesn't fire) rather than misfire.
function normalizeStatusForValidation(rawStatus) {
  const s = String(rawStatus == null ? "" : rawStatus).trim().toLowerCase();
  if (!s) return "";

  // Canonical regulatory values pass through (rare).
  switch (s) {
    case "draft":
      return "DRAFT";
    case "active":
      return "ACTIVE";
    case "mitigated":
      return "MITIGATED";
    case "closed":
    case "customer_accepted":
      return "CLOSED";
  }

  const ACTIVE_LIKE = new Set([
    "open",
    "in_progress",
    "in-progress",
    "inprogress",
    "submitted",
    "submitted_to_customer",
    "approved",
    "customer_rejected",
    "awaiting_customer",
    "escalated",
  ]);
  if (ACTIVE_LIKE.has(s)) return "ACTIVE";

  return "";
}

// Normalize an incident-shape object for engine consumption. Returns a
// NEW object (does not mutate input). Production data sends `location`
// as a free-text string; the engine's dot-path lookup on
// `location.state` would crash without normalization to an object
// shape. Other fields pass through untouched. Status is intentionally
// NOT rewritten on the object — it's normalized at the comparison
// point inside the executor/crossField checker, so we don't
// double-rewrite the field.
function normalizeIncidentForValidation(raw) {
  const out = { ...raw };
  const loc = raw && raw.location;
  if (typeof loc === "string") {
    out.location = { raw: loc };
  } else if (loc && typeof loc === "object") {
    out.location = loc;
  } else {
    out.location = {};
  }
  if (!Array.isArray(raw && raw.filingTypesRequired)) {
    out.filingTypesRequired = [];
  }
  return out;
}

// ── PORTED FROM validation/rulepacks/executor.ts ───────────────────
function executeRulepack(incident, pack) {
  const issues = [];

  // Normalize status ONCE per rulepack run. The rulepack JSON
  // `when.statusIn` is UPPERCASE; production data is lowercase.
  const normalizedStatus = normalizeStatusForValidation(
    incident && incident.status
  );

  for (const rule of (pack && pack.rules) || []) {
    // WHEN checks
    if (rule.when && Array.isArray(rule.when.statusIn) && rule.when.statusIn.length) {
      const expected = rule.when.statusIn.map((s) => String(s || "").toUpperCase());
      if (!expected.includes(normalizedStatus)) continue;
    }

    // REQUIRE field
    if (rule.require && rule.require.field) {
      const val = getByDotPath(incident, rule.require.field);
      const missing =
        val === undefined ||
        val === null ||
        (typeof val === "string" && val.trim() === "");
      if (missing) {
        issues.push({
          code: rule.code,
          path: `incident.${rule.require.field}`,
          message: rule.message,
          severity: rule.severity,
          filingType: pack.filingType,
        });
      }
    }
  }

  return issues;
}

// ── PORTED FROM validation/crossField.ts ───────────────────────────
function validateCrossFieldDependencies(incident) {
  const issues = [];

  if (incident && incident.resolvedTime && !incident.startTime) {
    issues.push({
      code: "cross.resolved_without_start",
      path: "incident.resolvedTime",
      message: "resolvedTime cannot exist without startTime",
      severity: "ERROR",
    });
  }

  const normalizedStatus = normalizeStatusForValidation(
    incident && incident.status
  );
  if (
    incident &&
    incident.affectedCustomers != null &&
    incident.affectedCustomers > 0 &&
    normalizedStatus === "DRAFT"
  ) {
    issues.push({
      code: "cross.affected_customers_requires_active",
      path: "incident.status",
      message: "Incident with affected customers cannot remain in DRAFT status",
      severity: "WARN",
    });
  }

  return issues;
}

// ── PORTED FROM validation/evidence.ts ─────────────────────────────
function detectMissingEvidence(pack, evidenceTypesPresent) {
  const issues = [];
  for (const req of (pack && pack.evidenceRequirements) || []) {
    const ok = Array.isArray(evidenceTypesPresent) && evidenceTypesPresent.includes(req.type);
    if (!ok) {
      issues.push({
        code: req.code,
        path: `evidence.type:${req.type}`,
        message: req.message,
        severity: req.severity,
        filingType: pack.filingType,
      });
    }
  }
  return issues;
}

// ── PORTED FROM validation/engine.ts ───────────────────────────────
function validateIncidentRequiredFields(incident) {
  const issues = [];
  const title = incident && incident.title;
  const hasTitle = typeof title === "string" && title.trim().length > 0;
  if (!hasTitle) {
    issues.push({
      code: "required_field_missing",
      path: "incident.title",
      message: "Incident title is required",
      severity: "ERROR",
    });
  }
  if (!incident || !incident.startTime) {
    issues.push({
      code: "required_field_missing",
      path: "incident.startTime",
      message: "Incident startTime is required",
      severity: "ERROR",
    });
  }
  return issues;
}

/**
 * Run the compliance check against a (possibly raw) incident. Caller
 * should pass the result of normalizeIncidentForValidation() but we
 * defensively normalize again here so the entry point is safe even
 * when callers forget.
 *
 * @param {object} incidentRaw            raw or normalized incident shape
 * @param {string[]} [evidenceTypesPresent]  upper-case evidence types found
 * @param {object} [opts]
 * @param {function} [opts.getRulepack]   override the rulepack source (testing)
 * @returns {{ ok: boolean, issues: Array, rulepackVersionsByType: object }}
 */
function runComplianceCheck(incidentRaw, evidenceTypesPresent, opts) {
  const { getRulepack } = (opts || {});
  const rulepackLookup = typeof getRulepack === "function"
    ? getRulepack
    : require("./_complianceRulepacks").getRulepack;

  const incident = normalizeIncidentForValidation(incidentRaw || {});
  const evList = Array.isArray(evidenceTypesPresent) ? evidenceTypesPresent : [];

  const issues = [
    ...validateIncidentRequiredFields(incident),
    ...validateCrossFieldDependencies(incident),
  ];

  // Track which rulepack versions were consulted, for snapshot meta.
  const rulepackVersionsByType = {};
  const filingTypes = Array.isArray(incident.filingTypesRequired)
    ? incident.filingTypesRequired
    : [];

  for (const filingType of filingTypes) {
    const pack = rulepackLookup(filingType);
    if (!pack) continue;
    rulepackVersionsByType[filingType] = pack.version || "v1";
    issues.push(...executeRulepack(incident, pack));
    issues.push(...detectMissingEvidence(pack, evList));
  }

  const ok = issues.every((i) => i.severity !== "ERROR");
  return { ok, issues, rulepackVersionsByType };
}

module.exports = {
  // High-level entry
  runComplianceCheck,
  // Adapter helpers (exposed for tests + the readiness hook)
  normalizeIncidentForValidation,
  normalizeStatusForValidation,
  // Sub-validators (exposed for diagnostic + differential tests)
  validateIncidentRequiredFields,
  validateCrossFieldDependencies,
  executeRulepack,
  detectMissingEvidence,
  // Utility
  getByDotPath,
};
