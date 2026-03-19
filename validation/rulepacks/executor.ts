import { IncidentValidated } from "../../contracts/validators/incident.zod";
import { ValidationIssue } from "../types";
import { getByDotPath } from "./getByDotPath";
import { Rulepack } from "./types";

export function executeRulepack(incident: IncidentValidated, pack: Rulepack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const rule of pack.rules || []) {
    // WHEN checks
    if (rule.when?.statusIn?.length) {
      if (!rule.when.statusIn.includes(incident.status)) continue;
    }

    // REQUIRE field
    if (rule.require?.field) {
      const val = getByDotPath(incident as any, rule.require.field);
      const missing =
        val === undefined || val === null || (typeof val === "string" && val.trim() === "");

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
