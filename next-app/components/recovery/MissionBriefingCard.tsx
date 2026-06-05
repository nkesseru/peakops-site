// PEAKOPS_RECOVERY_UI_V1 (PR 127d, extended PR 128b)
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
//
// PR 128b — adds the "Inferred from customer comment" marker when
// the backend derived cause.primary from the rejection comment. The
// operator can override with one click (opens an inline picker; first
// pick clears the marker via updateRecoveryCaseV1).

"use client";

import { useState } from "react";
import { getCauseNarrative } from "@/lib/recovery/causeNarratives";
import { formatRevenue, CAUSE_DISPLAY, CAUSE_ORDERED } from "@/lib/recovery/displayConstants";
import type { RevenueAtRisk, RecoveryCausePrimary } from "@/lib/recovery/types";

type Props = {
  causePrimary?: string;
  customerComment?: string;
  operatorNotes?: string;
  revenueAtRisk: RevenueAtRisk;
  daysOpen: number;
  // PR 128b — show "Inferred from customer comment" marker when true
  inferredFromComment?: boolean;
  // PR 128b — callback when operator picks an override cause. Parent
  // calls updateRecoveryCaseV1 which clears inferredFromComment.
  onOverrideCause?: (newCause: RecoveryCausePrimary) => void;
  // True while the override write is in flight
  overrideBusy?: boolean;
};

export function MissionBriefingCard({
  causePrimary,
  customerComment,
  operatorNotes,
  revenueAtRisk,
  daysOpen,
  inferredFromComment,
  onOverrideCause,
  overrideBusy,
}: Props) {
  const narrative = getCauseNarrative(causePrimary);
  const customer = String(customerComment || "").trim();
  const [showPicker, setShowPicker] = useState(false);

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

      {/* PR 128b — Inferred cause marker (only when the backend derived
          cause from the comment AND the operator hasn't overridden yet).
          One-click override opens an inline picker; choosing a different
          cause calls updateRecoveryCaseV1 which clears the marker. */}
      {inferredFromComment && onOverrideCause && (
        <div className="pt-2 border-t border-amber-400/20 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-200/90 bg-amber-400/10 border border-amber-300/30 rounded-full px-2.5 py-1">
              <span aria-hidden>✨</span>
              Inferred from customer comment
            </span>
            <button
              type="button"
              disabled={overrideBusy}
              onClick={() => setShowPicker((v) => !v)}
              className="text-[11px] text-amber-200/80 hover:text-amber-100 underline underline-offset-2 disabled:opacity-50"
            >
              {showPicker ? "Cancel" : "Change"}
            </button>
          </div>
          {showPicker && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
              <label className="text-[11px] text-amber-200/80 sm:shrink-0">
                Actual cause:
              </label>
              <select
                disabled={overrideBusy}
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value as RecoveryCausePrimary;
                  if (!v) return;
                  onOverrideCause(v);
                  setShowPicker(false);
                }}
                className="text-[12px] bg-black/40 border border-amber-300/30 rounded-lg px-2.5 py-1.5 text-white flex-1 min-w-0"
              >
                <option value="">— pick the actual cause —</option>
                {CAUSE_ORDERED.map((c) => (
                  <option key={c} value={c}>{CAUSE_DISPLAY[c]}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

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
