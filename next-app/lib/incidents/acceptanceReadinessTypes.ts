/**
 * PEAKOPS_ACCEPTANCE_READINESS_TYPES_V1 (PR 103b)
 *
 * Client-side TypeScript types mirroring the backend
 * functions_clean/_readiness.js output shape (PR 103a/104). These
 * are TYPES ONLY — no compute logic, no client mirror evaluator.
 *
 * Source of truth for these shapes is _readiness.js on the deploy
 * branch. If the backend shape changes, update these types to
 * match — the UI calls getAcceptanceReadinessV1 to obtain values,
 * never computes them.
 *
 * PR 104 — adds:
 *   - "template_check" and "template_check_unknown" categories
 *   - "unknown" as a third satisfaction value
 *   - requiredUnknown / encouragedUnknown summary counts
 *   - acceptanceCriteria prose (informational only)
 */

export type ReadinessState =
  | "ready_for_submission"
  | "requirements_missing"
  | "not_available";

export type ReadinessSatisfaction = boolean | "unknown";

export type ReadinessTier = "required" | "encouraged";

export type ReadinessCheckCategory =
  | "required_proof"
  | "approval"
  | "closure"
  | "attestation"          // reserved for PR 101 (never built)
  | "acknowledgment"       // reserved for PR 102 (never built)
  | "notes"                // reserved for future
  | "template_check"       // PR 104 — author-declared deterministic checks
  | "template_check_unknown"; // PR 104 — check type unrecognized by backend

export type ReadinessCheck = {
  key: string;
  label: string;
  category: ReadinessCheckCategory;
  tier: ReadinessTier;
  satisfied: ReadinessSatisfaction;
  detail?: string;
  // PR 120b — customer-authored rationale rendered as a "Reason:" line
  // under the check row. Persisted on the incident snapshot per PR 120a
  // (required_proof) and PR 118 (template_check). Optional — legacy
  // records and PR-118-only templates land without a description and
  // render today's visual unchanged.
  description?: string;
};

export type AcceptanceReadiness = {
  readinessVersion: number;
  state: ReadinessState;
  generatedAt: string; // ISO timestamp
  packetRevisionAtComputation?: number | null;
  requirementsSnapshotSource: string;
  summary: {
    requiredSatisfied: number;
    requiredTotal: number;
    requiredUnknown?: number;
    encouragedSatisfied: number;
    encouragedTotal: number;
    encouragedUnknown?: number;
  };
  checks: ReadinessCheck[];
};

/**
 * Cached on incident.readinessCache. Same shape as AcceptanceReadiness
 * but may include a Firestore Timestamp cachedAt field (shape varies
 * by SDK; treated as opaque on the client).
 */
export type ReadinessCacheEntry = AcceptanceReadiness & {
  cachedAt?: unknown; // Firestore Timestamp shape varies; not rendered
};

/**
 * PR 104 — Customer Acceptance Criteria prose (snapshotted from the
 * customer/org template). Informational only — never machine-evaluated,
 * never pass/fail. Surface in the Summary panel as a calm bulleted
 * list when present.
 */
export type AcceptanceCriteria = string[];
