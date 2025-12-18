import { IncidentValidated } from "../contracts/validators/incident.zod";
import { ValidationIssue, ValidationResult } from "./types";
import { validateForFiling } from "./filingRules";

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

export function runComplianceCheck(
  incident: IncidentValidated
): ValidationResult {
  const issues: ValidationIssue[] = [
    ...validateIncidentRequiredFields(incident),
  ];

  for (const filingType of incident.filingTypesRequired) {
    issues.push(...validateForFiling(incident, filingType));
  }

  return {
    ok: issues.every((i) => i.severity !== "ERROR"),
    issues,
  };
}
