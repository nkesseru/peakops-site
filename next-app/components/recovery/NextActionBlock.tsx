// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// THE dominant call-to-action on the case detail. "What do I do?"
// Three states:
//   1. Open / in_progress / blocked action exists → big CTA block
//   2. No actions at all → "Needs triage" warning + "Add Recovery Action"
//   3. All actions complete → "Ready to resolve" + Resolve CTA
//
// Distracted-user lens: this block should be the visually loudest
// element on the page. The verbs are imperatives.

"use client";

import { ACTION_TYPE_DISPLAY, OWNER_ROLE_DISPLAY } from "@/lib/recovery/displayConstants";
import { ActionStatusBadge } from "./StatusBadge";
import type { RecoveryAction, OwnerRole } from "@/lib/recovery/types";

type Props = {
  nextAction: RecoveryAction | null;
  assigneeNameResolver: (uid?: string | null) => string;
  busy: boolean;
  opErr?: string;
  onMarkInProgress: () => void;
  onMarkDone: () => void;
  onAttachEvidence: () => void;
  onAddAction: () => void;
  onResolveCase: () => void;
  allActionsDone: boolean;
};

export function NextActionBlock({
  nextAction,
  assigneeNameResolver,
  busy,
  opErr,
  onMarkInProgress,
  onMarkDone,
  onAttachEvidence,
  onAddAction,
  onResolveCase,
  allActionsDone,
}: Props) {
  // State 2: No actions → needs triage
  if (!nextAction && !allActionsDone) {
    return (
      <section className="rounded-xl border-2 border-amber-400/50 bg-amber-500/[0.08] px-5 py-5 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200">
          Next action
        </div>
        <div className="text-lg sm:text-xl text-amber-100 font-semibold">
          ⚠ Needs triage
        </div>
        <div className="text-[13px] text-amber-100/85">
          This case doesn&apos;t have a Recovery Action yet. Add one to start working.
        </div>
        {opErr && (
          <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">{opErr}</div>
        )}
        <button
          type="button"
          onClick={onAddAction}
          className="px-5 py-3 rounded-full text-sm font-semibold text-black bg-white hover:bg-white/90"
        >
          Add Recovery Action
        </button>
      </section>
    );
  }

  // State 3: all actions done → ready to resolve
  if (!nextAction && allActionsDone) {
    return (
      <section className="rounded-xl border-2 border-emerald-400/50 bg-emerald-500/[0.08] px-5 py-5 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-emerald-200">
          Next action
        </div>
        <div className="text-lg sm:text-xl text-emerald-100 font-semibold">
          ✓ All actions complete
        </div>
        <div className="text-[13px] text-emerald-100/85">
          Recovery work is done. Resolve this case to capture the outcome.
        </div>
        {opErr && (
          <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">{opErr}</div>
        )}
        <button
          type="button"
          onClick={onResolveCase}
          className="px-5 py-3 rounded-full text-sm font-semibold text-black bg-white hover:bg-white/90"
        >
          Resolve case
        </button>
      </section>
    );
  }

  // State 1: there's a next action
  const a = nextAction!;
  const typeLabel = ACTION_TYPE_DISPLAY[a.type] || a.type;
  const assigneeDisplay = a.assignee ? assigneeNameResolver(a.assignee) : "";
  const roleDisplay = a.assigneeRole
    ? OWNER_ROLE_DISPLAY[a.assigneeRole as OwnerRole] || a.assigneeRole
    : "";

  return (
    <section className="rounded-xl border-2 border-blue-400/40 bg-blue-500/[0.08] px-5 py-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-blue-200">
          Next action
        </div>
        <ActionStatusBadge status={a.status} />
      </div>

      <div className="text-lg sm:text-xl text-white font-semibold leading-snug">
        {typeLabel}
      </div>

      {a.title && a.title !== typeLabel && (
        <div className="text-sm text-blue-100/90 leading-relaxed">
          {a.title}
        </div>
      )}
      {a.description && (
        <div className="text-[13px] text-blue-100/80 leading-relaxed whitespace-pre-line">
          {a.description}
        </div>
      )}

      {(assigneeDisplay || roleDisplay) && (
        <div className="text-[12px] text-blue-200/80">
          Assigned to {assigneeDisplay}
          {roleDisplay && <span className="text-blue-200/60"> ({roleDisplay})</span>}
        </div>
      )}

      {a.evidence && a.evidence.length > 0 && (
        <div className="text-[11px] text-blue-200/70">
          {a.evidence.length} evidence item{a.evidence.length === 1 ? "" : "s"} attached
        </div>
      )}

      {a.status === "blocked" && a.blockingReason && (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/[0.10] px-3 py-2 text-[12px] text-rose-100">
          Blocked: {a.blockingReason}
        </div>
      )}

      {opErr && (
        <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">{opErr}</div>
      )}

      <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.06]">
        {a.status === "open" && (
          <button
            type="button"
            disabled={busy}
            onClick={onMarkInProgress}
            className="px-4 py-2.5 rounded-full text-[13px] font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            I&apos;m working on it
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onMarkDone}
          className="px-4 py-2.5 rounded-full text-[13px] font-semibold text-black bg-white hover:bg-white/90 disabled:opacity-50"
        >
          Mark done
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onAttachEvidence}
          className="px-4 py-2.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] disabled:opacity-50"
        >
          Attach evidence
        </button>
      </div>
    </section>
  );
}
