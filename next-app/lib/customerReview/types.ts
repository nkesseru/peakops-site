// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Shared types between the customer-facing review page and the
// operator-side mint modal. Mirrors the backend response shapes from
// getCustomerReviewV1 (PR 126a/d/e) and createCustomerReviewLinkV1
// (PR 126a/c).
//
// No business logic lives here — pure type definitions.

export type RequirementsSource = "snapshot" | "template_live" | "none";
export type ArchetypeSource = "snapshot" | "incident_field" | "title_derived" | "none";
export type SourceStatus = "in_progress" | "closed";
export type ConsumedAction = "accepted" | "rejected";

export type CustomerReviewRequirementItem = {
  label: string;
  description: string;
};

export type CustomerReviewAcceptanceCheck = {
  type: string;
  tier: "required" | "encouraged";
  label: string;
  description: string;
};

export type CustomerReviewReadinessCheck = {
  key?: string;
  label?: string;
  category?: string;
  tier?: "required" | "encouraged";
  satisfied?: boolean;
  detail?: string;
  description?: string;
};

export type CustomerReviewReadiness = {
  ready: boolean;
  label: string;
  checks: CustomerReviewReadinessCheck[];
};

export type CustomerReviewEvidenceItem = {
  id: string;
  filename: string;
  caption: string;
  slotKey: string;
  capturedAt: string | null;
  gps: { lat: number | null; lng: number | null; accuracyM: number | null } | null;
};

export type CustomerReviewDossierData = {
  customerLabel: string;
  archetype: string;
  templateKey: string;
  templateVersion: number | null;
  requirementsSource: RequirementsSource;
  archetypeSource: ArchetypeSource;
  title: string;
  location: string;
  summary: string;
  requirements: {
    requiredProof: CustomerReviewRequirementItem[];
    optionalProof: string[];
    acceptanceCriteria: string[];
  };
  acceptanceChecks: CustomerReviewAcceptanceCheck[];
  readiness: CustomerReviewReadiness;
  evidenceItems: CustomerReviewEvidenceItem[];
  createdAt: string | null;
  submittedToCustomerAt: string | null;
  coordinatorDisplayName: string;
};

export type GetCustomerReviewResponse = {
  ok: boolean;
  tokenHashPrefix?: string;
  status?: string;
  consumed?: boolean;
  consumedAction?: ConsumedAction | null;
  review?: CustomerReviewDossierData;
  error?: string;
};

export type SubmitCustomerReviewResponse = {
  ok: boolean;
  tokenHashPrefix?: string;
  action?: ConsumedAction;
  status?: string;
  error?: string;
  detail?: string;
};

export type CreateCustomerReviewLinkResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  token?: string;
  tokenHashPrefix?: string;
  url?: string;
  status?: string;
  templateKey?: string;
  templateVersion?: number | null;
  customerLabel?: string;
  sourceStatus?: SourceStatus;
  error?: string;
  detail?: string;
  reasons?: Array<{ jobId: string; title: string; status: string; reviewStatus: string }>;
};

// PR 126b — customer-facing display strings approved 2026-06-02.
// Keep mappings explicit; never auto-translate or fuzzy.
export const REQUIREMENTS_SOURCE_DISPLAY: Record<RequirementsSource, string> = {
  snapshot: "Archived requirements",
  template_live: "Current requirements",
  none: "Custom requirements",
};
