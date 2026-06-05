// PEAKOPS_RECOVERY_UI_V1 (PR 129b)
//
// The "What do I do?" answer when the case is at ready_to_resubmit:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │  ✓ All recovery actions complete                         │
//   │                                                          │
//   │  Resubmit the corrected packet to the customer.          │
//   │                                                          │
//   │  Optional: what changed? (one line, customer-side prep)  │
//   │  [ Create resubmission review link  →  ]                 │
//   └──────────────────────────────────────────────────────────┘
//
// Wedge guards (UI-side):
//   - Single button. No batch resubmission, no auto-send-to-customer.
//   - changeSummary is optional + operator-authored only — defer
//     auto-derivation to PR 129c per architecture lock.
//   - No email/notification UI surface. The mint returns a URL, the
//     operator chooses how to share.

"use client";

import { useState } from "react";

const CHANGE_SUMMARY_MAX = 1000;

type Props = {
  /** True while mintResubmissionLinkV1 is in flight. */
  busy: boolean;
  /** Error message from the mint endpoint, if any. */
  errorMessage?: string;
  /** Called when the operator clicks "Create resubmission review link." */
  onMint: (args: { changeSummary?: string }) => void;
};

export function ResubmissionBanner({ busy, errorMessage, onMint }: Props) {
  const [changeSummary, setChangeSummary] = useState("");

  return (
    <section className="rounded-xl border-2 border-emerald-400/50 bg-gradient-to-b from-emerald-500/[0.12] to-emerald-500/[0.04] px-5 py-5 sm:px-6 sm:py-6 space-y-4">
      <div className="text-[10px] uppercase tracking-[0.22em] font-semibold text-emerald-200">
        Next step
      </div>

      <div className="space-y-2">
        <div className="text-xl sm:text-2xl text-white font-semibold leading-snug">
          ✓ All recovery actions complete
        </div>
        <div className="text-[14px] sm:text-[15px] text-emerald-50/90 leading-relaxed">
          Resubmit the corrected packet for customer review.
        </div>
      </div>

      <div className="space-y-1.5 pt-2 border-t border-emerald-400/20">
        <label className="block text-[11px] text-emerald-100/80 uppercase tracking-wider font-semibold">
          What changed? <span className="text-emerald-200/60 normal-case font-normal">(optional, for your records)</span>
        </label>
        <textarea
          className="w-full text-sm bg-black/30 border border-emerald-300/25 rounded-lg px-3 py-2 placeholder-emerald-100/40 text-emerald-50 focus:outline-none focus:ring-1 focus:ring-emerald-300/50"
          placeholder="e.g. Re-captured proof for slot 3; added OTDR trace as requested."
          rows={2}
          maxLength={CHANGE_SUMMARY_MAX}
          disabled={busy}
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
        />
      </div>

      {errorMessage && (
        <div className="rounded-lg border border-red-300/30 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onMint({ changeSummary: changeSummary.trim() || undefined })}
          className={
            "w-full sm:w-auto px-5 py-3 rounded-full text-sm font-semibold transition " +
            (busy
              ? "bg-white/10 text-gray-400 cursor-not-allowed"
              : "bg-white text-black hover:bg-white/90")
          }
        >
          {busy ? "Creating link…" : "Create resubmission review link →"}
        </button>
        <span className="text-[11px] text-emerald-100/70">
          We&apos;ll generate a URL. You share it with the customer (no auto-send).
        </span>
      </div>
    </section>
  );
}
