// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Shared types between the Recovery list + detail surfaces and the
// operator-side mint flow. Mirrors the backend response shapes from
// listRecoveryCasesV1, getRecoveryCaseV1, createRecoveryCaseV1,
// updateRecoveryCaseV1, addRecoveryActionV1, updateRecoveryActionV1
// (PR 127a + 127a1 + 127a2 + 127a3).
//
// Wedge guard reminder (encoded in copy + UX, not just types):
// RecoveryCase = "work required to recover revenue", NOT "a ticket."

export type RecoveryStatus =
  | "open"
  | "triaged"
  | "in_progress"
  | "awaiting_customer"
  | "escalated"
  | "recovered"
  | "partial_recovery"
  | "abandoned"
  | "expired";

export type RecoveryPriority = "low" | "medium" | "high" | "critical";

export type RecoverySource = "customer_rejected" | "internal_qc";

export type RevenueType = "actual" | "estimated" | "unknown";

export type RecoveryCausePrimary =
  | "missing_required_proof"
  | "proof_quality_insufficient"
  | "wrong_proof_uploaded"
  | "documentation_error"
  | "customer_changed_requirements"
  | "scope_dispute"
  | "compliance_failure"
  | "unclear_customer_feedback"
  | "internal_qc_caught"
  // PR 128a — telecom blind spot (OTDR trace, loss measurement, splice report)
  | "missing_test_result"
  | "other";

export type OwnerRole = "coordinator" | "supervisor" | "field_lead" | "manager";

export type RecoveryActionType =
  | "recapture_proof"
  | "clarify_with_customer"
  | "internal_qc_check"
  | "re_submit_to_customer"
  | "escalate_internal"
  | "escalate_to_customer"
  | "documentation_fix"
  | "field_revisit"
  // PR 127a3 — telecom/fiber recovery-specific
  | "provide_test_results"
  | "other";

export type RecoveryActionStatus = "open" | "in_progress" | "blocked" | "done" | "skipped";

export type RevenueAtRisk = {
  amount: number;
  currency: string;
  type: RevenueType;
  notes?: string;
  enteredBy?: string;
  enteredAt?: string | null;
};

export type RecoveryCauseDetail = {
  primary?: RecoveryCausePrimary | "";
  secondary?: string;
  customerComment?: string;
  operatorNotes?: string;
  categorizedBy?: string;
  categorizedAt?: string | null;
  // PR 128a — true when cause.primary was derived from the customer
  // comment at case-creation time. Cleared by updateRecoveryCaseV1
  // whenever an operator manually sets cause.primary.
  inferredFromComment?: boolean;
};

// PR 128b — pre-filled action recommendation from the backend
// RECOVERY_CAUSE_AUTOMATION map. Backend filters out any suggestion
// whose type already exists on the case, so the UI can render this
// array directly.
export type SuggestedAction = {
  type: RecoveryActionType;
  title: string;
  description: string;
  assigneeRole: OwnerRole | "";
};

export type PacketVersionRef = {
  packetVersionId: string;
  outcome?: "pending" | "accepted" | "rejected" | "revoked" | "expired" | string;
  outcomeAt?: string | null;
  mintedAt?: string | null;
  mintedBy?: string;
  customerComment?: string | null;
  templateVersionAtMint?: number | null;
};

export type RecoveryOwnership = {
  owner?: string;
  ownerRole?: OwnerRole | "";
  assignedAt?: string | null;
  assignedBy?: string;
  history?: Array<{
    uid: string;
    role: string;
    fromTs?: any;
    toTs?: string;
  }>;
};

export type RecoveryResolution = {
  outcome: "recovered" | "partial_recovery" | "abandoned" | "expired";
  resolvedBy?: string;
  resolvedAt?: string | null;
  finalAmount?: number | null;
  notes?: string;
};

export type RecoveryCaseListItem = {
  caseId: string;
  incidentId: string;
  // PR 127c-a — denormed from incident doc
  jobTitle?: string;
  jobLocation?: string;
  title?: string;
  templateKey?: string;
  templateVersion?: number | null;
  status: RecoveryStatus;
  priority: RecoveryPriority;
  revenueAtRisk: { amount: number; currency: string; type: RevenueType };
  cause: { primary?: string; customerComment?: string };
  owner?: string;
  ownerRole?: string;
  daysOpen: number;
  cycleCount: number;
  openedAt?: string | null;
  updatedAt?: string | null;
  resolvedAt?: string | null;
  resolutionOutcome?: string;
};

export type ListRecoveryCasesResponse = {
  ok: boolean;
  orgId?: string;
  cases?: RecoveryCaseListItem[];
  totals?: { cases: number; openCases: number; openRevenue: number };
  error?: string;
};

export type RecoveryAction = {
  id: string;
  caseId: string;
  type: RecoveryActionType;
  title: string;
  description?: string;
  status: RecoveryActionStatus;
  assignee?: string;
  assigneeRole?: OwnerRole | "";
  evidence: Array<{ evidenceId: string; addedBy?: string; addedAt?: string }>;
  outcome?: string;
  blockingReason?: string;
  dueAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  createdBy?: string;
};

export type RecoveryAuditEvent = {
  id: string;
  type: string;
  actorUid?: string;
  actorRole?: string;
  actionId?: string;
  before?: any;
  after?: any;
  meta?: any;
  createdAt?: string | null;
};

export type RecoveryCaseDetail = {
  caseId: string;
  orgId: string;
  incidentId: string;
  // PR 127c-a — denormed from incident doc
  jobTitle?: string;
  jobLocation?: string;
  templateKey?: string;
  templateVersion?: number | null;
  status: RecoveryStatus;
  priority: RecoveryPriority;
  revenueAtRisk: RevenueAtRisk;
  cause: RecoveryCauseDetail;
  rejection: {
    source?: RecoverySource | "";
    tokenHashPrefix?: string;
    rejectedAt?: string | null;
    rejectedBy?: string;
  };
  ownership: RecoveryOwnership;
  packetVersions: PacketVersionRef[];
  currentPacketVersion?: string;
  cycleCount: number;
  openedAt?: string | null;
  daysOpen: number;
  resolvedAt?: string | null;
  resolution?: RecoveryResolution | null;
  createdAt?: string | null;
  createdBy?: string;
  updatedAt?: string | null;
  updatedBy?: string;
};

export type GetRecoveryCaseResponse = {
  ok: boolean;
  orgId?: string;
  caseId?: string;
  case?: RecoveryCaseDetail;
  actions?: RecoveryAction[];
  audit?: RecoveryAuditEvent[];
  // PR 128b — pre-filtered against actions already on the case.
  // Empty when cause.primary is unset or all suggestions added.
  suggestedActions?: SuggestedAction[];
  error?: string;
};

export type CreateRecoveryCaseResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  caseId?: string;
  status?: RecoveryStatus;
  priority?: RecoveryPriority;
  source?: RecoverySource;
  error?: string;
  detail?: string;
};

export type UpdateRecoveryCaseResponse = {
  ok: boolean;
  orgId?: string;
  caseId?: string;
  status?: RecoveryStatus;
  noop?: boolean;
  auditCount?: number;
  error?: string;
  detail?: string;
  currentStatus?: RecoveryStatus;
  attemptedStatus?: RecoveryStatus;
};
