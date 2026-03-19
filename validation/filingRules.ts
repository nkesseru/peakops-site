import { IncidentValidated } from "../contracts/validators/incident.zod";
import { FilingType } from "../contracts/filings/filingTypes";
import { ValidationIssue } from "./types";

export function validateForFiling(
  incident: IncidentValidated,
  filingType: FilingType
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (filingType === "DIRS") {
    if (incident.affectedCustomers == null) {
      issues.push({
        code: "required_field_missing",
        path: "incident.affectedCustomers",
        message: "DIRS requires affectedCustomers",
        severity: "ERROR",
        filingType,
      });
    }
  }

  if (filingType === "OE_417") {
    if (!incident.location?.state) {
      issues.push({
        code: "required_field_missing",
        path: "incident.location.state",
        message: "OE-417 requires state location",
        severity: "ERROR",
        filingType,
      });
    }
  }

  return issues;
}
