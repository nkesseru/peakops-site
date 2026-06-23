// PR 133B — Shared types for operator-facing compliance UI.
//
// Mirrors the persisted shape produced by functions_clean/_readiness.js
// (computeComplianceReadiness) when an org's validation.mode is
// "passive_persist" or "block". When mode is "off" or "passive_log"
// this field is absent on the incident doc and the UI should fall
// back to acceptance-readiness-only rendering.

export type ComplianceSeverity = "ERROR" | "WARN" | "INFO";

export type ComplianceState =
  | "clear"
  | "issues_advisory"
  | "issues_blocking"
  | "not_run";

export interface ComplianceIssue {
  code: string;
  severity: ComplianceSeverity;
  message?: string;
  filingType?: string;
  source?: string;
}

export interface ComplianceReadinessSummary {
  errorCount: number;
  warnCount: number;
  infoCount: number;
  topIssueCodes: string[];
  missingFields?: string[];
}

export interface ComplianceReadiness {
  state: ComplianceState;
  ok: boolean;
  filingTypes?: string[];
  rulepackVersionsByType?: Record<string, string>;
  issues: ComplianceIssue[];
  summary: ComplianceReadinessSummary;
  ranAt?: unknown; // serverTimestamp; presence-only for the UI
}

// Acceptance readiness state values from PR 108's readinessCache.
// Promoted here so the chip can derive a unified status across both
// readiness signals.
export type AcceptanceReadinessState =
  | "not_available"
  | "ready_for_submission"
  | "requirements_missing";

// Shape of the 412 compliance_block response from the gated callables
// (exportIncidentPacketV1, createCustomerReviewLinkV1,
// mintResubmissionLinkV1) per PR 133C.
export interface ComplianceBlockResponse {
  ok: false;
  error: "compliance_block";
  mode: string;
  codes: Array<{ code: string; severity: ComplianceSeverity; source: string }>;
  overridable: boolean;
  rulepackVersionsByType?: Record<string, string>;
  overrideHint?: string;
  ackError?: "override_required" | "override_role_required" | "override_reason_invalid";
}
