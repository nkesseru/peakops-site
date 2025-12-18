export type Severity = "INFO" | "WARN" | "ERROR";

export interface RulepackWhen {
  statusIn?: string[];
}

export interface RequireField {
  field: string; // supports dot paths: "location.state"
}

export interface Rule {
  code: string;
  when?: RulepackWhen;
  require?: RequireField;
  message: string;
  severity: Severity;
}

export interface EvidenceRequirement {
  code: string;
  type: string; // EvidenceType
  message: string;
  severity: Severity;
}

export interface Rulepack {
  version: string;
  filingType: string;
  rules: Rule[];
  evidenceRequirements: EvidenceRequirement[];
}
