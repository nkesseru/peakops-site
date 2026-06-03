// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Single Recovery Action row inside the case detail. NOT a task —
// the copy emphasizes "what must happen next" verbs. Status pill,
// type label, assignee role, and inline action transitions.

"use client";

import type { RecoveryAction } from "@/lib/recovery/types";
import { ACTION_TYPE_DISPLAY, ACTION_STATUS_DISPLAY, OWNER_ROLE_DISPLAY } from "@/lib/recovery/displayConstants";
import { ActionStatusBadge } from "./StatusBadge";

type Props = {
  action: RecoveryAction;
  busy?: boolean;
  onMarkInProgress?: () => void;
  onMarkDone?: () => void;
  onAttachEvidence?: () => void;
};

function fmtIso(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function RecoveryActionListItem({ action, busy, onMarkInProgress, onMarkDone, onAttachEvidence }: Props) {
  const typeLabel = ACTION_TYPE_DISPLAY[action.type] || action.type;
  const isTerminal = action.status === "done" || action.status === "skipped";

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ActionStatusBadge status={action.status} />
            <span className="text-[12px] text-amber-200/80 font-medium">{typeLabel}</span>
          </div>
          <div className="text-sm text-white font-medium mt-1.5 break-words">{action.title}</div>
          {action.description && (
            <div className="text-[12px] text-gray-400 mt-1 leading-relaxed whitespace-pre-line">{action.description}</div>
          )}
          {action.assigneeRole && (
            <div className="text-[11px] text-gray-500 mt-1.5">
              Assigned to {OWNER_ROLE_DISPLAY[action.assigneeRole as keyof typeof OWNER_ROLE_DISPLAY] || action.assigneeRole}
              {action.assignee && <span className="ml-1.5 font-mono">· {action.assignee}</span>}
            </div>
          )}
          {action.outcome && action.status === "done" && (
            <div className="text-[12px] text-emerald-200/80 mt-1.5 italic">
              ✓ {action.outcome}
            </div>
          )}
          {action.evidence && action.evidence.length > 0 && (
            <div className="text-[11px] text-gray-500 mt-1.5">
              {action.evidence.length} evidence item{action.evidence.length === 1 ? "" : "s"} attached
            </div>
          )}
          {action.completedAt && (
            <div className="text-[11px] text-gray-500 mt-0.5">
              Completed {fmtIso(action.completedAt)}
            </div>
          )}
        </div>
      </div>

      {!isTerminal && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-white/[0.05]">
          {action.status === "open" && onMarkInProgress && (
            <button
              type="button"
              disabled={busy}
              onClick={onMarkInProgress}
              className="text-[11px] px-3 py-1.5 rounded-full border border-blue-400/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 disabled:opacity-50"
            >
              Mark in progress
            </button>
          )}
          {(action.status === "open" || action.status === "in_progress" || action.status === "blocked") && onMarkDone && (
            <button
              type="button"
              disabled={busy}
              onClick={onMarkDone}
              className="text-[11px] px-3 py-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              Mark done
            </button>
          )}
          {onAttachEvidence && (
            <button
              type="button"
              disabled={busy}
              onClick={onAttachEvidence}
              className="text-[11px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] disabled:opacity-50"
            >
              Attach evidence
            </button>
          )}
        </div>
      )}
    </div>
  );
}
