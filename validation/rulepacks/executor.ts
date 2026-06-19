import { IncidentValidated } from "../../contracts/validators/incident.zod";
import { ValidationIssue } from "../types";
import { getByDotPath } from "./getByDotPath";
import { Rulepack } from "./types";
import { normalizeStatusForValidation } from "../_realityAdapter";

export function executeRulepack(incident: IncidentValidated, pack: Rulepack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // PR 133A — Normalize the incident's status ONCE per rulepack run.
  // Production data uses lowercase lifecycle values (`open`, `in_progress`,
  // `closed`, `customer_accepted`, etc.). Rulepacks `when.statusIn`
  // expects UPPERCASE regulatory values (`ACTIVE`, `MITIGATED`, `CLOSED`).
  // We normalize so the WHEN check compares apples to apples without
  // touching the rulepack JSON.
  const normalizedStatus = normalizeStatusForValidation(incident.status as unknown as string);

  for (const rule of pack.rules || []) {
    // WHEN checks
    if (rule.when?.statusIn?.length) {
      const expected = rule.when.statusIn.map((s) => String(s || "").toUpperCase());
      if (!expected.includes(normalizedStatus)) continue;
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
