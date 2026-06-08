// PEAKOPS_RECOVERY_READINESS_STRIP_V1 (PR 131b)
//
// Sits directly under MissionBriefingCard and answers the single most
// important coordinator question: "Can I send this back?"
//
// Three visual states (decision lock 2026-06-08):
//   green   → "Ready to resubmit"   (case.status === ready_to_resubmit)
//   red     → "Not ready"           (open/in_progress/escalated with blocking work)
//   neutral → "Case closed"         (terminal or awaiting_customer)
//
// No amber state in MVP (decision lock #2). Warnings are surfaced
// inside the green state as a subline; they don't change the chip.
//
// The strip itself is non-interactive. The mint CTA lives below in
// the ResubmissionBanner (already shipped in PR 129b).
//
// Wedge guards:
//   - No "click to mint" affordance here — that belongs in
//     ResubmissionBanner. The strip is purely informational.
//   - No countdown / SLA / time-pressure language.
//   - No "PeakOps thinks you should..." copy. The strip reports
//     state, not advice.

"use client";

import type { ResubmissionReadiness } from "@/lib/recovery/types";

type Props = {
  readiness: ResubmissionReadiness;
};

export function ReadinessStrip({ readiness }: Props) {
  const isGreen = readiness.state === "green";
  const isRed = readiness.state === "red";

  const containerCls = isGreen
    ? "border-emerald-400/30 bg-emerald-500/[0.07]"
    : isRed
      ? "border-rose-400/30 bg-rose-500/[0.07]"
      : "border-white/10 bg-white/[0.03]";

  const dotCls = isGreen
    ? "bg-emerald-400"
    : isRed
      ? "bg-rose-400"
      : "bg-gray-500";

  const headlineCls = isGreen
    ? "text-emerald-100"
    : isRed
      ? "text-rose-100"
      : "text-gray-300";

  return (
    <section
      className={`rounded-xl border px-4 py-3 sm:px-5 sm:py-3.5 ${containerCls}`}
      aria-label="Resubmission readiness"
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1 inline-block h-2.5 w-2.5 rounded-full shrink-0 ${dotCls}`}
          aria-hidden
        />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className={`text-sm sm:text-base font-semibold leading-snug ${headlineCls}`}>
            {readiness.headline}
          </div>

          {readiness.reasons.length > 0 && (
            <ul className="space-y-0.5">
              {readiness.reasons.map((r, i) => (
                <li key={i} className="text-[12.5px] text-gray-200 leading-relaxed">
                  {r}
                </li>
              ))}
            </ul>
          )}

          {/* Warnings surface inside the green chip as a softer signal —
              "you can mint, but X is worth a glance." No amber state. */}
          {readiness.warnings.length > 0 && (
            <ul className="space-y-0.5 pt-1">
              {readiness.warnings.map((w, i) => (
                <li key={i} className="text-[12px] text-amber-200/85 leading-relaxed">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
