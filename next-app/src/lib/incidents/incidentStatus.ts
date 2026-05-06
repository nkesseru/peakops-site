// PEAKOPS_CANONICAL_STATE_V1 (2026-05-05)
// This module is a thin compatibility layer over the canonical
// resolver at `./resolveJobDisplayState`. Older surfaces import
// `incidentStatusLabel` / `incidentStatusPill` / `deriveDisplayStatus`
// from here; those exports now route through the canonical resolver
// so every status pill on every page agrees on the same priority
// rules. New code should call `resolveJobDisplayState` directly.

import {
  resolveJobDisplayState,
  type JobDisplayState,
} from "./resolveJobDisplayState";

export function normalizeIncidentStatusShared(status: unknown): string {
  return String(status || "").trim().toLowerCase();
}

export function incidentStatusLabel(status: unknown): string {
  const s = normalizeIncidentStatusShared(status);
  if (!s) return "-";
  return resolveJobDisplayState({ status });
}

export function deriveDisplayStatus(input: {
  rawStatus?: string;
  hasArrival?: boolean;
  hasSubmitted?: boolean;
  allApproved?: boolean;
  anyRejected?: boolean;
}): JobDisplayState {
  return resolveJobDisplayState({
    status: input.rawStatus,
    hasArrival: input.hasArrival,
    hasSubmitted: input.hasSubmitted,
    allTasksApproved: input.allApproved,
    anyRejected: input.anyRejected,
  });
}

const PILL_BY_STATE: Record<JobDisplayState, string> = {
  Open: "bg-emerald-500/15 border-emerald-300/30 text-emerald-100",
  "In Progress": "bg-cyan-500/15 border-cyan-300/30 text-cyan-100",
  "Awaiting Supervisor Review": "bg-amber-500/15 border-amber-300/30 text-amber-100",
  Approved: "bg-green-600/20 border-green-400/30 text-green-100",
  "Sent Back": "bg-rose-500/15 border-rose-300/30 text-rose-100",
  Closed: "bg-white/10 border-white/20 text-gray-200",
};

export function incidentStatusPill(status: unknown): string {
  const state = resolveJobDisplayState({ status });
  return PILL_BY_STATE[state] || "bg-white/10 border-white/20 text-gray-200";
}
