// PEAKOPS_RECOVERY_FOREMAN_TYPES_V1 (PR 130b)
//
// Stripped types matching the listRecoveryActionsForIncidentV1
// response shape (PR 130a backend).
//
// IMPORTANT: This file lives separately from lib/recovery/types.ts on
// purpose. The foreman UI bundle must NOT import RecoveryCase /
// RecoveryStatus / RecoveryCause* types — those carry vocabulary the
// field user should never see (resubmissionCount, awaiting_customer,
// missing_required_proof, etc.).
//
// If the backend response evolves, update THIS file. Resist the urge
// to share the action type with lib/recovery/types.ts — keeping the
// boundary explicit prevents accidental leakage.

// The 10 known recovery action types — kept as a string union here
// rather than importing from lib/recovery/types.ts so this file
// stays standalone. The labels live in displayConstants but only
// ACTION_TYPE_DISPLAY is imported by the foreman component (whitelist
// of one constant — see RecoveryWorkSection comment).
export type ForemanWorkType =
  | "recapture_proof"
  | "clarify_with_customer"
  | "internal_qc_check"
  | "re_submit_to_customer"
  | "escalate_internal"
  | "escalate_to_customer"
  | "documentation_fix"
  | "field_revisit"
  | "provide_test_results"
  | "other";

export type ForemanWorkStatus = "open" | "in_progress" | "blocked";

// The exact shape returned by listRecoveryActionsForIncidentV1
// (per PR 130a). Note: no caseId, no case-level fields, by design.
export type ForemanOpenWorkItem = {
  id: string;
  type: ForemanWorkType | string; // tolerant of future types
  title: string;
  description: string;
  status: ForemanWorkStatus;
  assignee: string;
  assigneeRole: string;
  evidenceCount: number;
  startedAt: string | null;
  dueAt: string | null;
  blockingReason: string;
  // PR 130a — internal routing-only; never displayed. The completion
  // call (completeRecoveryFieldWorkV1) takes incidentId + actionId, so
  // this field is unused by the UI today but kept on the type for
  // forward compatibility with the backend response.
  _routeCaseId: string;
};

export type ListForemanWorkResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  openWork?: ForemanOpenWorkItem[];
  error?: string;
};

export type CompleteForemanWorkResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  actionId?: string;
  noop?: boolean;
  auditCount?: number;
  caseAutoFlippedToReadyToResubmit?: boolean;
  error?: string;
  detail?: string;
};
