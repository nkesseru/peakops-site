export type ValidationSeverity = "INFO" | "WARN" | "ERROR";

export interface ValidationIssue {
  code: string;               // e.g. "required_field_missing"
  path: string;               // e.g. "incident.startTime"
  message: string;
  severity: ValidationSeverity;
  filingType?: string;        // "DIRS" | "OE_417" | etc
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
