// PR 135B — UI mirror of the server-side capture-gate filter.
//
// MUST stay byte-aligned with functions_clean/_captureGate.js's
// isCaptureRelevantCheck() — if a check type is added there, mirror
// it here in the same commit. The drift guard at
// scripts/dev/test_capture_gate_ui.mjs holds the two sides in sync.
//
// Why a UI mirror at all? The readinessCache the UI reads from
// Firestore contains ALL evaluator results (capture-side AND
// downstream like supervisor_approval / incident_closure). The
// server-side gate filters to capture-relevant before deciding to
// block. The UI must filter the same way so the operator only sees
// items they can actually act on at submit/complete time —
// otherwise the notice would surface "Supervisor approval"
// (downstream, not the tech's job) as a missing item.

import type { ReadinessCheck, ReadinessCache } from "./types";

export function isCaptureRelevantCheck(check: ReadinessCheck): boolean {
  const key = String(check?.key || "");
  return (
    key.startsWith("template_check__min_proof_") ||
    key === "template_check__one_gps_proof" ||
    key === "template_check__field_notes"
  );
}

/**
 * Returns the capture-relevant, required-tier, unsatisfied checks
 * the operator needs to address before submit/complete.
 */
export function captureRelevantMissing(readiness: ReadinessCache | null | undefined): ReadinessCheck[] {
  if (!readiness || !Array.isArray(readiness.checks)) return [];
  return readiness.checks.filter(
    (c) => c && c.tier === "required" && c.satisfied === false && isCaptureRelevantCheck(c)
  );
}

/**
 * True when the operator should be BLOCKED from clicking
 * submit/complete (UI gate). Mirrors the server's enforcement
 * predicate. Note: when the org is in passive_log/off mode, the
 * server would NOT block — but the UI doesn't know the mode and
 * uses the same conservative disable so a tech can't ship an
 * incomplete record by accident even in advisory mode. The
 * admin/owner override path stays available regardless.
 */
export function captureGateShouldDisable(readiness: ReadinessCache | null | undefined): boolean {
  return captureRelevantMissing(readiness).length > 0;
}
