/**
 * PEAKOPS_READINESS_PILL_V1 (PR 103b)
 *
 * Compact state pill — "Ready for submission" / "Requirements missing"
 * (and intentionally NOTHING for "not_available" or missing data;
 * callers omit the pill in those cases per approved scope).
 *
 * Used by:
 *   - SummaryClient.tsx (Acceptance Readiness panel header)
 *   - RecordsClient.tsx (per-card pill when readinessCache present)
 *
 * No percentages. No probability language. No emoji other than the
 * neutral tone the palette gives. Color binding mirrors the packet
 * audit-HTML tone classes (approved/warn/neutral) so the operator
 * sees the same color whether reading the packet or the UI.
 */

"use client";

import type { ReadinessState } from "@/lib/incidents/acceptanceReadinessTypes";

const STATE_COPY: Record<ReadinessState, { label: string; tone: "approved" | "warn" | "neutral" }> = {
  ready_for_submission: { label: "Ready for submission", tone: "approved" },
  requirements_missing: { label: "Requirements missing", tone: "warn" },
  not_available:        { label: "Not available",        tone: "neutral" },
};

const TONE_CLASS: Record<"approved" | "warn" | "neutral", string> = {
  approved: "bg-emerald-500/15 text-emerald-200 border-emerald-300/30",
  warn:     "bg-amber-500/15 text-amber-100 border-amber-300/30",
  neutral:  "bg-white/5 text-gray-300 border-white/15",
};

export function ReadinessPill({
  state,
  size = "md",
  className = "",
}: {
  state: ReadinessState | null | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!state) return null;
  const copy = STATE_COPY[state];
  if (!copy) return null;
  const sizeClasses = size === "sm"
    ? "px-2 py-0.5 text-[10px] tracking-[0.06em]"
    : "px-2.5 py-1 text-[11px] tracking-[0.04em]";
  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold uppercase ${sizeClasses} ${TONE_CLASS[copy.tone]} ${className}`}
      title="Acceptance readiness state"
    >
      {copy.label}
    </span>
  );
}
