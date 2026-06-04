// PEAKOPS_RECOVERY_UI_V1 (PR 127d)
//
// MISSION briefing card — replaces the 2-stat hero + WhatsWrong
// section from PR 127c-b. Reads top-down like a briefing, not a
// dashboard:
//
//   PROBLEM   (customer voice if present, else humanized cause label)
//   REASON    (why this matters — narrative)
//   IMPACT    ($X in dispute · Yd aging, small footnote)
//
// The 3-second test: a distracted foreman opens the case and knows
// (a) what's wrong, (b) why it matters, (c) what's at stake — before
// scrolling.

"use client";

import { getCauseNarrative } from "@/lib/recovery/causeNarratives";
import { formatRevenue } from "@/lib/recovery/displayConstants";
import type { RevenueAtRisk } from "@/lib/recovery/types";

type Props = {
  causePrimary?: string;
  customerComment?: string;
  operatorNotes?: string;
  revenueAtRisk: RevenueAtRisk;
  daysOpen: number;
};

export function MissionBriefingCard({
  causePrimary,
  customerComment,
  operatorNotes,
  revenueAtRisk,
  daysOpen,
}: Props) {
  const narrative = getCauseNarrative(causePrimary);
  const customer = String(customerComment || "").trim();

  const amount = Number(revenueAtRisk.amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const impactText = hasAmount
    ? `${formatRevenue(amount, revenueAtRisk.currency || "USD")} in dispute · ${daysOpen}d aging`
    : `Revenue at risk unknown · ${daysOpen}d aging`;

  return (
    <section className="rounded-xl border border-amber-400/30 bg-gradient-to-b from-amber-500/[0.08] to-white/[0.02] px-5 py-5 sm:px-6 sm:py-6 space-y-4">
      <div className="text-[10px] uppercase tracking-[0.22em] font-semibold text-amber-300/90">
        Mission
      </div>

      {/* PROBLEM — customer voice if available, else narrative title */}
      {customer ? (
        <div className="text-xl sm:text-2xl font-semibold text-white leading-snug italic">
          &ldquo;{customer}&rdquo;
        </div>
      ) : (
        <div className="text-xl sm:text-2xl font-semibold text-white leading-snug">
          {narrative.titleFallback}
        </div>
      )}

      {/* REASON — narrative paragraph (always present) */}
      <div className="text-[14px] sm:text-[15px] text-gray-200/90 leading-relaxed">
        {narrative.why}
      </div>

      {/* Operator add — surfaces operator-authored notes inside the briefing */}
      {operatorNotes && operatorNotes.trim().length > 0 && (
        <div className="text-[13px] text-gray-300 leading-relaxed pt-2 border-t border-amber-400/20">
          <span className="text-amber-200/80 font-medium">Operator added:</span>{" "}
          {operatorNotes.trim()}
        </div>
      )}

      {/* IMPACT — small footnote */}
      <div className="text-[11px] uppercase tracking-wider text-amber-200/70 pt-2 border-t border-amber-400/20 font-medium">
        {impactText}
      </div>
    </section>
  );
}
