// PEAKOPS_RECOVERY_UI_V1 (PR 129b) + PR recovery-B (combined CTA).
//
// The "What do I do?" answer when the case is at ready_to_resubmit:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │  ✓ All recovery actions complete                         │
//   │                                                          │
//   │  Resubmit the corrected packet to the customer.          │
//   │                                                          │
//   │  Optional: what changed? (one line, customer-side prep)  │
//   │  [ Regenerate & resubmit  →  ]                           │
//   └──────────────────────────────────────────────────────────┘
//
// PR recovery-B — the button now runs a TWO-STEP pipeline:
//   1. exportIncidentPacketV1  →  fresh signed packet (new revision)
//   2. mintResubmissionLinkV1  →  customer review link pinned to (1)
// Progressive disclosure surfaces each stage via `stage` prop.
// Iron rule: if step 1 fails the parent MUST NOT call step 2 — pinning
// a stale (already-rejected) packet would re-send the same content to
// the customer. Always-export keeps the loop honest.
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
  /** True while the regenerate+resubmit pipeline is in flight. */
  busy: boolean;
  /** PR recovery-B — sub-state during the pipeline:
      "regenerating" → calling exportIncidentPacketV1
      "minting"      → calling mintResubmissionLinkV1
      null/undefined → idle (or `busy` with no specific stage) */
  stage?: "regenerating" | "minting" | null;
  /** Error message from either step, if any. */
  errorMessage?: string;
  /** PR recovery-B — replaces onMint. Parent runs export-then-mint. */
  onRegenerateAndResubmit: (args: { changeSummary?: string }) => void;
  /** PR 131b — Pre-fill value for the "What changed?" textarea, from
      PR 131a's suggestions.changeSummary backend helper. When null,
      the entire "What changed?" section is hidden (decision lock #5:
      "Hide section entirely. Do not show placeholders.") */
  changeSummarySuggestion?: string | null;
};

export function ResubmissionBanner({ busy, stage, errorMessage, onRegenerateAndResubmit, changeSummarySuggestion }: Props) {
  // PR 131b — pre-fill from backend suggestion when present. The
  // operator can edit or clear (uncontrolled after first mount).
  const [changeSummary, setChangeSummary] = useState(
    typeof changeSummarySuggestion === "string" ? changeSummarySuggestion : ""
  );
  const showChangeSummarySection = Boolean(changeSummarySuggestion);

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

      {/* PR 131b — Hidden entirely when no suggestion exists (decision
          lock #5). When shown, the textarea is pre-filled with the
          backend-derived bullet list; operator can edit or clear. */}
      {showChangeSummarySection && (
        <div className="space-y-1.5 pt-2 border-t border-emerald-400/20">
          <label className="block text-[11px] text-emerald-100/80 uppercase tracking-wider font-semibold">
            What changed?{" "}
            <span className="text-emerald-200/60 normal-case font-normal">
              (auto-filled from completed actions — edit as needed)
            </span>
          </label>
          <textarea
            className="w-full text-sm bg-black/30 border border-emerald-300/25 rounded-lg px-3 py-2 placeholder-emerald-100/40 text-emerald-50 focus:outline-none focus:ring-1 focus:ring-emerald-300/50"
            rows={Math.min(8, Math.max(3, changeSummary.split("\n").length + 1))}
            maxLength={CHANGE_SUMMARY_MAX}
            disabled={busy}
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
          />
        </div>
      )}

      {errorMessage && (
        <div className="rounded-lg border border-red-300/30 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2">
        <button
          type="button"
          data-testid="resubmission-banner-cta"
          data-stage={stage || (busy ? "busy" : "idle")}
          disabled={busy}
          onClick={() => onRegenerateAndResubmit({ changeSummary: changeSummary.trim() || undefined })}
          className={
            "w-full sm:w-auto px-5 py-3 rounded-full text-sm font-semibold transition " +
            (busy
              ? "bg-white/10 text-gray-400 cursor-not-allowed"
              : "bg-white text-black hover:bg-white/90")
          }
        >
          {/* PR recovery-B — progressive disclosure of the two-step
              pipeline. "Regenerating packet…" surfaces while the
              fresh signed packet is building (~30-60s); "Minting
              resubmission link…" surfaces during the brief mint+pin
              step (~1-2s). Idle copy frames the combined action so
              the operator knows BOTH steps happen on click. */}
          {stage === "regenerating"
            ? "Regenerating packet…"
            : stage === "minting"
              ? "Minting resubmission link…"
              : busy
                ? "Working…"
                : "Regenerate & resubmit →"}
        </button>
        <span className="text-[11px] text-emerald-100/70">
          We&apos;ll regenerate a fresh signed packet and mint a new resubmission link. You share the URL (no auto-send).
        </span>
      </div>
    </section>
  );
}
