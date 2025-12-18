import { ValidationIssue } from "./types";
import { Rulepack } from "./rulepacks/types";

export function detectMissingEvidence(
  pack: Rulepack,
  evidenceTypesPresent: string[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const req of pack.evidenceRequirements || []) {
    const ok = evidenceTypesPresent.includes(req.type);
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
