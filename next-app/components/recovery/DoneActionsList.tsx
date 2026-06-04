// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// "Did I finish it?" — single-line list of completed Recovery Actions,
// visible without expansion (per planning override #7).
//
// Also shows non-next OPEN actions in a smaller subsection so the
// operator can still see queued work without losing the NEXT ACTION
// primacy.

"use client";

import { ACTION_TYPE_DISPLAY } from "@/lib/recovery/displayConstants";
import type { RecoveryAction } from "@/lib/recovery/types";

type Props = {
  done: RecoveryAction[];
  otherOpen: RecoveryAction[];
  assigneeNameResolver: (uid?: string | null) => string;
};

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function DoneActionsList({ done, otherOpen, assigneeNameResolver }: Props) {
  return (
    <section className="space-y-2.5">
      {otherOpen.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
            Other open actions
          </div>
          <div className="space-y-1">
            {otherOpen.map((a) => (
              <SingleLine
                key={a.id}
                icon="◯"
                iconClass="text-gray-400"
                label={ACTION_TYPE_DISPLAY[a.type] || a.type}
                title={a.title}
                meta={a.assignee ? `assigned to ${assigneeNameResolver(a.assignee)}` : ""}
              />
            ))}
          </div>
        </div>
      )}
      {done.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
            Done
          </div>
          <div className="space-y-1">
            {done.map((a) => (
              <SingleLine
                key={a.id}
                icon={a.status === "skipped" ? "—" : "✓"}
                iconClass={a.status === "skipped" ? "text-gray-500" : "text-emerald-300"}
                label={ACTION_TYPE_DISPLAY[a.type] || a.type}
                title={a.title}
                meta={
                  [
                    a.completedAt ? fmtDate(a.completedAt) : "",
                    a.assignee ? `by ${assigneeNameResolver(a.assignee)}` : "",
                  ].filter(Boolean).join(" · ")
                }
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SingleLine({
  icon, iconClass, label, title, meta,
}: {
  icon: string;
  iconClass: string;
  label: string;
  title?: string;
  meta: string;
}) {
  return (
    <div className="flex items-start gap-2 text-[12px] py-1">
      <span className={`flex-shrink-0 w-4 ${iconClass} font-semibold leading-tight`}>{icon}</span>
      <div className="flex-1 min-w-0 leading-snug">
        <span className="text-gray-200 font-medium">{label}</span>
        {title && <span className="text-gray-400"> — {title}</span>}
        {meta && <span className="text-gray-500 ml-1.5">· {meta}</span>}
      </div>
    </div>
  );
}
