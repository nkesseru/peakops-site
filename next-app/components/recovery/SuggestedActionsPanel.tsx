// PEAKOPS_RECOVERY_UI_V1 (PR 128b)
//
// Suggested Actions panel — pre-filled action recommendations from
// the backend RECOVERY_CAUSE_AUTOMATION map. Sits directly under the
// MISSION briefing card so the operator goes:
//
//   What's wrong?  (MissionBriefingCard above)
//        ↓
//   What do I do?  (this panel)
//
// Wedge guards (UI side):
//   - Nothing writes to the case until the operator clicks [Add].
//   - [Add all] is only visible when the panel is expanded — the
//     collapsed peek-state cannot bulk-add by accident.
//   - We do not pre-assign a person. We do show the role hint
//     (Field lead / Coordinator / Supervisor / Manager) so the
//     operator knows who this belongs to, but actual assignment
//     stays a separate decision.
//   - No notifications, no automation, no chains beyond this list.

"use client";

import { useState } from "react";
import type { SuggestedAction, OwnerRole } from "@/lib/recovery/types";
import { OWNER_ROLE_DISPLAY } from "@/lib/recovery/displayConstants";

type Props = {
  suggestions: SuggestedAction[];
  /** True while a single add is in flight; we disable that row. */
  busyType?: string;
  /** True while [Add all] is in flight; we disable everything. */
  busyAddAll?: boolean;
  errorMessage?: string;
  onAdd: (suggestion: SuggestedAction) => void;
  onAddAll: (suggestions: SuggestedAction[]) => void;
};

export function SuggestedActionsPanel({
  suggestions,
  busyType,
  busyAddAll,
  errorMessage,
  onAdd,
  onAddAll,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!suggestions || suggestions.length === 0) return null;

  const count = suggestions.length;
  const headerLabel = count === 1
    ? "1 suggested action"
    : `${count} suggested actions`;

  return (
    <section className="rounded-xl border border-sky-300/25 bg-sky-500/[0.04] overflow-hidden">
      {/* Header — clickable, collapses/expands */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full px-4 sm:px-5 py-3 flex items-center justify-between gap-3 text-left hover:bg-sky-500/[0.06] transition"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-sky-200/80">
            What should I do?
          </span>
          <span className="text-[11px] text-sky-100/70">· {headerLabel}</span>
        </div>
        <span className="text-sky-200/70 text-[14px] shrink-0" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {/* Collapsed peek — show titles only so the operator can scan
          without expanding. Tappable area but no [Add] button yet. */}
      {!expanded && (
        <div className="px-4 sm:px-5 pb-3 -mt-1 space-y-1">
          {suggestions.map((s, i) => (
            <div
              key={`${s.type}-${i}`}
              className="text-[13px] text-sky-100/90 truncate"
            >
              · {s.title}
            </div>
          ))}
          <div className="text-[11px] text-sky-200/60 pt-1">
            Tap to expand · operator approves each one
          </div>
        </div>
      )}

      {/* Expanded — full action cards + [Add] per row + [Add all] */}
      {expanded && (
        <div className="border-t border-sky-300/15">
          <ul className="divide-y divide-sky-300/15">
            {suggestions.map((s, i) => {
              const isBusy = Boolean(busyAddAll) || busyType === s.type;
              return (
                <li key={`${s.type}-${i}`} className="px-4 sm:px-5 py-3.5">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white">
                          {s.title}
                        </span>
                        {s.assigneeRole && (
                          <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-semibold text-sky-200/80 bg-sky-400/10 border border-sky-300/25 rounded-full px-2 py-0.5">
                            {OWNER_ROLE_DISPLAY[s.assigneeRole as OwnerRole]}
                          </span>
                        )}
                      </div>
                      {s.description && (
                        <div className="text-[12.5px] text-gray-300 leading-relaxed">
                          {s.description}
                        </div>
                      )}
                    </div>
                    <div className="pt-2 sm:pt-0 sm:shrink-0">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onAdd(s)}
                        className={
                          "w-full sm:w-auto px-4 py-2 rounded-full text-[12px] font-semibold transition " +
                          (isBusy
                            ? "bg-white/10 text-gray-500 cursor-not-allowed"
                            : "bg-white text-black hover:bg-white/90")
                        }
                      >
                        {busyType === s.type ? "Adding…" : "Add"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* [Add all] — only visible when expanded, per planning #5 */}
          {count > 1 && (
            <div className="px-4 sm:px-5 py-3 border-t border-sky-300/15 bg-sky-500/[0.03] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="text-[11px] text-sky-200/70">
                Adds all {count} suggestions as Open actions on this case.
              </div>
              <button
                type="button"
                disabled={Boolean(busyAddAll) || Boolean(busyType)}
                onClick={() => onAddAll(suggestions)}
                className={
                  "w-full sm:w-auto px-4 py-2 rounded-full text-[12px] font-semibold transition border " +
                  (busyAddAll || busyType
                    ? "bg-white/5 text-gray-500 border-white/10 cursor-not-allowed"
                    : "bg-transparent text-sky-100 border-sky-300/40 hover:bg-sky-400/10")
                }
              >
                {busyAddAll ? "Adding all…" : `Add all ${count}`}
              </button>
            </div>
          )}

          {errorMessage && (
            <div className="mx-4 sm:mx-5 my-3 rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
              {errorMessage}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
