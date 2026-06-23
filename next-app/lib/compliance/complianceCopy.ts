// PR 133B — Pure helpers for operator-facing compliance copy.
//
// Code dictionary keeps backend codes (DIRS rule codes + the
// synthetic "acceptance.requirements_missing") aligned with plain-
// English operator explanations and one-line suggested actions.
// Anything not in the dictionary falls back to humanizing the code
// string — the UI never goes blank.
//
// Pure functions only — exported as plain TS so the drift-guard
// script (scripts/dev/test_compliance_copy.mjs) can require/import
// them without React.

import type {
  ComplianceReadiness,
  ComplianceIssue,
  ComplianceSeverity,
  AcceptanceReadinessState,
} from "./types";

export type ChipState = "ready" | "warning" | "blocking" | "unknown";

export interface ChipDescriptor {
  state: ChipState;
  label: string;          // e.g. "Compliance: 4 blockers, 2 warnings"
  blockerCount: number;
  warningCount: number;
  infoCount: number;
}

interface CopyEntry {
  title: string;
  explanation: string;
  action?: string;
}

const CODE_DICTIONARY: Record<string, CopyEntry> = {
  "dirs.entity.identification.required": {
    title: "Reporting entity not identified",
    explanation: "FCC § 4.11 requires every DIRS submission to identify the reporting provider. PeakOps reads this from the incident's customer field.",
    action: "Set the customer / reporting-provider label on the incident.",
  },
  "dirs.geographic_area.required": {
    title: "Geographic area not specified",
    explanation: "FCC § 4.11 requires the geographic area affected, with county-level granularity where possible.",
    action: "Populate the location field on the incident.",
  },
  "dirs.affected_population.required": {
    title: "Affected user/customer count missing",
    explanation: "FCC § 4.9 + § 4.11 require the count of affected users for service-effect threshold routing.",
    action: "Set affectedCustomers on the incident.",
  },
  "dirs.problem_description.required": {
    title: "Brief problem description missing",
    explanation: "FCC § 4.11 expects a short narrative summary alongside the structured fields.",
    action: "Use the incident notes field to describe what happened.",
  },
  "dirs.service_category.recommended": {
    title: "Service category not set",
    explanation: "Without the archetype (PeakOps proxy for FCC provider category), the right § 4.9 threshold can't be routed.",
    action: "Pick an archetype that matches this incident type.",
  },
  "dirs.priority.recommended": {
    title: "Priority not set",
    explanation: "DIRS triage workflows in practice depend on operator-supplied priority signaling.",
    action: "Set priority on the incident (high / normal / low).",
  },
  "dirs.evidence.outageProof": {
    title: "Operational log missing",
    explanation: "FCC DIRS guidance asks for substantiation — an OSS event log, NOC ticket, or network alarm capture.",
    action: "Upload at least one LOG-type evidence item.",
  },
  "dirs.evidence.situationReport": {
    title: "Operator situation report missing",
    explanation: "A human-authored summary doc complements the structured fields for multi-day events.",
    action: "Upload at least one DOCUMENT-type evidence item (advisory only).",
  },
  "dirs.evidence.restorationProof": {
    title: "Restoration proof missing",
    explanation: "Closed-status DIRS incidents benefit from post-repair test logs (e.g. OTDR sweep within spec).",
    action: "Upload a post-restoration LOG when the incident is closed.",
  },
  "acceptance.requirements_missing": {
    title: "Required acceptance proof missing",
    explanation: "The customer acceptance template has required-proof items that have not been satisfied.",
    action: "Open the readiness panel above to see which required items are unmet.",
  },
  "required_field_missing": {
    title: "Required field missing",
    explanation: "The validator engine flagged a required field on the incident as empty.",
    action: "Check the incident's notes / customer / location fields and complete any blanks.",
  },
};

export function explainCode(code: string): CopyEntry {
  if (CODE_DICTIONARY[code]) return CODE_DICTIONARY[code];
  // Fallback — humanize the dotted code.
  const parts = String(code || "").split(/[._]/).filter(Boolean);
  const title = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || "Unknown finding";
  return {
    title,
    explanation: `Finding code "${code}" was emitted by the validator. No detailed copy is registered for this code yet.`,
  };
}

// Derive the unified status chip from both readiness signals.
//
// Priority (worst-case wins):
//   1. Blocking — either compliance has ERROR-severity findings OR
//      acceptance has unsatisfied required proof.
//   2. Warning — compliance has WARN/INFO findings only.
//   3. Ready — both signals clean (or compliance not run + acceptance ready).
//   4. Unknown — neither signal has any data (no validation mode set,
//      no template).
export function deriveChipState(
  compliance: ComplianceReadiness | null | undefined,
  acceptanceState: AcceptanceReadinessState | null | undefined,
): ChipDescriptor {
  const summary = compliance?.summary || { errorCount: 0, warnCount: 0, infoCount: 0, topIssueCodes: [] };
  const blockerCount = summary.errorCount || 0;
  const warningCount = summary.warnCount || 0;
  const infoCount = summary.infoCount || 0;

  const acceptanceMissing = acceptanceState === "requirements_missing";
  const acceptanceReady = acceptanceState === "ready_for_submission";
  const acceptanceUnknown = !acceptanceState || acceptanceState === "not_available";

  if (blockerCount > 0 || acceptanceMissing) {
    const parts: string[] = [];
    if (blockerCount > 0) parts.push(`${blockerCount} ${blockerCount === 1 ? "blocker" : "blockers"}`);
    if (acceptanceMissing && blockerCount === 0) parts.push("required proof missing");
    if (warningCount > 0) parts.push(`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`);
    return {
      state: "blocking",
      label: `Compliance: ${parts.join(", ")}`,
      blockerCount: blockerCount + (acceptanceMissing && blockerCount === 0 ? 1 : 0),
      warningCount,
      infoCount,
    };
  }

  if (warningCount > 0 || infoCount > 0) {
    const parts: string[] = [];
    if (warningCount > 0) parts.push(`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`);
    if (infoCount > 0) parts.push(`${infoCount} info`);
    return {
      state: "warning",
      label: `Compliance: ${parts.join(", ")}`,
      blockerCount: 0,
      warningCount,
      infoCount,
    };
  }

  if (acceptanceReady && compliance && compliance.state === "clear") {
    return { state: "ready", label: "Compliance: ready", blockerCount: 0, warningCount: 0, infoCount: 0 };
  }
  if (acceptanceReady && !compliance) {
    // Compliance never ran (mode=off or passive_log on this org).
    return { state: "ready", label: "Acceptance: ready", blockerCount: 0, warningCount: 0, infoCount: 0 };
  }

  if (acceptanceUnknown && !compliance) {
    return { state: "unknown", label: "Compliance: not evaluated", blockerCount: 0, warningCount: 0, infoCount: 0 };
  }

  return { state: "ready", label: "Compliance: ready", blockerCount: 0, warningCount: 0, infoCount: 0 };
}

// Sort issues with most-severe first for the panel rendering.
export function sortIssuesBySeverity(issues: ComplianceIssue[]): ComplianceIssue[] {
  const rank = (s: ComplianceSeverity) => (s === "ERROR" ? 0 : s === "WARN" ? 1 : 2);
  return [...(issues || [])].sort((a, b) => rank(a.severity) - rank(b.severity));
}

export function severityCopy(s: ComplianceSeverity): { label: string; tone: "red" | "amber" | "blue" } {
  if (s === "ERROR") return { label: "BLOCKING", tone: "red" };
  if (s === "WARN") return { label: "WARNING", tone: "amber" };
  return { label: "INFO", tone: "blue" };
}
