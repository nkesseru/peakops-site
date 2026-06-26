// PR 135B — UI-side types for the capture-gate surface.
//
// Mirrors functions_clean/_captureGate.js + the readinessCache
// check-row shape from functions_clean/_readiness.js. UI-only —
// no server-side imports.

export type CheckTier = "required" | "encouraged";

export interface ReadinessCheck {
  key: string;
  label: string;
  category?: string;
  tier: CheckTier;
  satisfied: boolean | "unknown";
  detail?: string;
  description?: string;
}

export type AcceptanceReadinessState =
  | "not_available"
  | "ready_for_submission"
  | "requirements_missing";

export interface ReadinessCache {
  readinessVersion?: number;
  state: AcceptanceReadinessState;
  generatedAt?: string;
  checks?: ReadinessCheck[];
  summary?: {
    requiredSatisfied?: number;
    requiredTotal?: number;
    requiredUnknown?: number;
    encouragedSatisfied?: number;
    encouragedTotal?: number;
    encouragedUnknown?: number;
  };
}

// Shape returned by the 412 capture_gate_blocked response from
// submitFieldSessionV1 / markJobCompleteV1 (PR 135A).
export interface CaptureGateBlockResponse {
  ok: false;
  error: "capture_gate_blocked";
  mode: string;
  missing: Array<{ key: string; label: string; tier?: string; detail?: string | null }>;
  overridable: boolean;
  ackError?: "override_required" | "override_role_required" | "override_reason_invalid";
  detail?: string;
}
