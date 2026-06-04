// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
// "What is wrong?" — customer voice first, then cause label.

"use client";

import { CAUSE_DISPLAY } from "@/lib/recovery/displayConstants";
import type { RecoveryCausePrimary } from "@/lib/recovery/types";

type Props = {
  causePrimary: string;
  customerComment?: string;
  operatorNotes?: string;
};

export function WhatsWrongSection({ causePrimary, customerComment, operatorNotes }: Props) {
  const causeLabel = causePrimary
    ? (CAUSE_DISPLAY[causePrimary as RecoveryCausePrimary] || causePrimary)
    : "Not yet triaged";
  const isUntriaged = !causePrimary;

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
        What&apos;s wrong
      </div>
      {customerComment ? (
        <div className="text-base text-white leading-relaxed italic">
          &ldquo;{customerComment}&rdquo;
        </div>
      ) : null}
      <div className={"text-sm " + (isUntriaged ? "text-amber-300/80 italic" : "text-gray-200")}>
        {isUntriaged ? "⚠ " : ""}
        {causeLabel}
      </div>
      {operatorNotes && (
        <div className="text-[12px] text-gray-400 pt-1.5 border-t border-white/[0.05]">
          <span className="text-gray-500">Operator note:</span> {operatorNotes}
        </div>
      )}
    </section>
  );
}
