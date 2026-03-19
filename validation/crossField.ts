import { IncidentValidated } from "../contracts/validators/incident.zod";
import { ValidationIssue } from "./types";

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

  if (
    incident.affectedCustomers != null &&
    incident.affectedCustomers > 0 &&
    incident.status === "DRAFT"
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
