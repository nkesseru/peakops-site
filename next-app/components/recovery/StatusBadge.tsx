// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
import type { RecoveryStatus, RecoveryActionStatus } from "@/lib/recovery/types";
import {
  STATUS_DISPLAY,
  STATUS_PILL_CLASS,
  ACTION_STATUS_DISPLAY,
  ACTION_STATUS_PILL_CLASS,
} from "@/lib/recovery/displayConstants";

export function CaseStatusBadge({ status, size = "md" }: { status: RecoveryStatus; size?: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-1";
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${STATUS_PILL_CLASS[status]} ${sizeClass}`}>
      {STATUS_DISPLAY[status]}
    </span>
  );
}

export function ActionStatusBadge({ status }: { status: RecoveryActionStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 ${ACTION_STATUS_PILL_CLASS[status]}`}>
      {ACTION_STATUS_DISPLAY[status]}
    </span>
  );
}
