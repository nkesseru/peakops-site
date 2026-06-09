import { IncidentValidated } from "../contracts/validators/incident.zod";
import { ValidationIssue } from "./types";
import { normalizeStatusForValidation } from "./_realityAdapter";

export function validateCrossFieldDependencies(
  incident: IncidentValidated
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (incident.resolvedTime && !incident.startTime) {
    issues.push({
      code: "cross.resolved_without_start",
      path: "incident.resolvedTime",
      message: "resolvedTime cannot exist without startTime",
      severity: "ERROR",
    });
  }

  // PR 133A — Compare against the normalized lifecycle value so this
  // rule fires consistently whether the incoming incident carries
  // "draft" (production lowercase) or "DRAFT" (rulepack canonical).
  const normalizedStatus = normalizeStatusForValidation(incident.status as unknown as string);
  if (
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
