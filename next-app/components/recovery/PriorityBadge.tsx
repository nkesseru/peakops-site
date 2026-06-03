// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
// Priority badge — derived value, never editable in UI.
// Colors approved 2026-06-03: critical red / high amber / medium yellow / low gray.

import type { RecoveryPriority } from "@/lib/recovery/types";
import {
  PRIORITY_DISPLAY,
  PRIORITY_PILL_CLASS,
  PRIORITY_DOT_CLASS,
} from "@/lib/recovery/displayConstants";

type Props = {
  priority: RecoveryPriority;
  size?: "sm" | "md";
};

export function PriorityBadge({ priority, size = "md" }: Props) {
  const sizeClass = size === "sm"
    ? "text-[10px] px-2 py-0.5 gap-1"
    : "text-xs px-2.5 py-1 gap-1.5";
  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold uppercase tracking-wider ${PRIORITY_PILL_CLASS[priority]} ${sizeClass}`}
      title={`Priority is system-derived from revenue at risk + aging`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${PRIORITY_DOT_CLASS[priority]}`} />
      {PRIORITY_DISPLAY[priority]}
    </span>
  );
}
