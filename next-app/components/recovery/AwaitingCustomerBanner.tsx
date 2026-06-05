// PEAKOPS_RECOVERY_UI_V1 (PR 129b)
//
// Replaces the NextActionBlock when the case is at awaiting_customer.
// Tone: passive / informational. There is nothing for the coordinator
// to do here except wait, copy the link if they need to resend, or
// escalate / abandon if the customer is non-responsive.
//
// Wedge guards:
//   - No reminder / nudge / email automation.
//   - No SLA / due date.
//   - "Resend" is just a copy operation; the link is already minted.

"use client";

import { useState } from "react";
import type { PacketVersionRef } from "@/lib/recovery/types";

function fmtIso(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type Props = {
  currentPacket?: PacketVersionRef;
  /** Pre-built customer URL when the last mint happened in-session.
      Falsy on cold load — the cleartext token isn't retrievable. */
  cachedReviewUrl?: string;
  /** Days since mint (informational only — no SLA). */
  daysOpen: number;
};

export function AwaitingCustomerBanner({ currentPacket, cachedReviewUrl, daysOpen }: Props) {
  const [copied, setCopied] = useState(false);

  const ordinal = currentPacket?.ordinal;
  const mintedAt = fmtIso(currentPacket?.mintedAt);
  const changeSummary = currentPacket?.changeSummary || "";

  function onCopy() {
    if (!cachedReviewUrl) return;
    try {
      navigator.clipboard.writeText(cachedReviewUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — operator can still select + copy manually */
    }
  }

  return (
    <section className="rounded-xl border-2 border-violet-400/40 bg-violet-500/[0.07] px-5 py-5 sm:px-6 sm:py-6 space-y-3">
      <div className="text-[10px] uppercase tracking-[0.22em] font-semibold text-violet-200">
        Status
      </div>

      <div className="space-y-1.5">
        <div className="text-xl sm:text-2xl text-white font-semibold leading-snug">
          Waiting on customer review
        </div>
        <div className="text-[13px] sm:text-[14px] text-violet-100/85 leading-relaxed">
          {ordinal != null
            ? `Resubmission v${ordinal} sent${mintedAt ? ` ${mintedAt}` : ""}.`
            : "Customer review link minted."}{" "}
          When the customer responds, this case will update automatically.
        </div>
        {daysOpen >= 7 && (
          <div className="text-[12px] text-amber-200/90 pt-1">
            ⏱ Aging {daysOpen}d — consider escalating or reaching out directly.
          </div>
        )}
      </div>

      {changeSummary && (
        <div className="text-[12px] text-violet-100/80 italic leading-relaxed pt-2 border-t border-violet-400/15">
          <span className="not-italic text-violet-200/80 font-medium">What changed:</span>{" "}
          {changeSummary}
        </div>
      )}

      {cachedReviewUrl && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2 border-t border-violet-400/15">
          <code className="flex-1 truncate text-[11px] text-violet-100/80 bg-black/30 border border-violet-300/20 rounded px-2 py-1.5 font-mono">
            {cachedReviewUrl}
          </code>
          <button
            type="button"
            onClick={onCopy}
            className="shrink-0 text-[11px] px-3 py-1.5 rounded-full border border-violet-300/30 hover:bg-violet-400/10 text-violet-100"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {!cachedReviewUrl && (
        <div className="text-[11px] text-violet-200/60 pt-2 border-t border-violet-400/15">
          Review link was returned once at mint time and isn&apos;t recoverable.
          If you need to resend, escalate or wait for the customer to respond.
        </div>
      )}
    </section>
  );
}
