import { IncidentValidated } from "../contracts/validators/incident.zod";
import { ValidationIssue, ValidationResult } from "./types";
import { getRulepack } from "./rulepacks";
import { executeRulepack } from "./rulepacks/executor";
import { detectMissingEvidence } from "./evidence";

export function validateIncidentRequiredFields(
  incident: IncidentValidated
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!incident.title?.trim()) {
    issues.push({
      code: "required_field_missing",
      path: "incident.title",
      message: "Incident title is required",
      severity: "ERROR",
    });
  }

  if (!incident.startTime) {
    issues.push({
      code: "required_field_missing",
      path: "incident.startTime",
      message: "Incident startTime is required",
      severity: "ERROR",
    });
  }

  return issues;
}

// For now, evidence types are passed in; later we pull from Firestore
export function runComplianceCheck(
  incident: IncidentValidated,
  evidenceTypesPresent: string[] = []
): ValidationResult {
  const issues: ValidationIssue[] = [
    ...validateIncidentRequiredFields(incident),
  ];

  for (const filingType of incident.filingTypesRequired) {
    const pack = getRulepack(filingType);
    if (!pack) continue;

    issues.push(...executeRulepack(incident, pack));
    issues.push(...detectMissingEvidence(pack, evidenceTypesPresent));
  }

  return {
    ok: issues.every((i) => i.severity !== "ERROR"),
    issues,
  };
}
