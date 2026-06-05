// PEAKOPS_RECOVERY_UI_V1 (PR 129b)
//
// Modal shown once after a successful mintResubmissionLinkV1 call.
// Holds the cleartext review URL for the operator to copy and share.
// After dismissal, the cleartext is gone — it's not stored server-side,
// only the hash is.
//
// Wedge guards:
//   - No "send to customer" button. The operator chooses the channel.
//   - No customer contact field — that would slide toward CRM.
//   - One-time display + clear visual cue that this URL won't reappear.

"use client";

import { useState } from "react";

type Props = {
  url: string;
  ordinal: number;
  /** Optional cleartext token, for displays that want to render it
      separately. Today we just show the full URL. */
  token?: string;
  onClose: () => void;
};

export function ResubmissionLinkResultModal({ url, ordinal, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  // Build the full URL with origin so the operator can paste anywhere.
  // The mint returns a path-relative URL (/review/<token>); origin
  // comes from window.location.
  const fullUrl = (() => {
    if (typeof window === "undefined") return url;
    if (/^https?:\/\//.test(url)) return url;
    return `${window.location.origin}${url}`;
  })();

  function onCopy() {
    try {
      navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — operator can still select + copy manually */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-lg bg-black border border-emerald-300/30 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-emerald-300/15 bg-gradient-to-b from-emerald-500/[0.10] to-transparent">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-emerald-200">
            Resubmission link created
          </div>
          <h2 className="text-base font-semibold tracking-tight mt-1">
            v{ordinal} review URL — send to customer
          </h2>
          <p className="text-[12px] text-emerald-100/80 mt-1.5">
            Copy this URL and share with the customer (email, text, whatever you
            normally use). The case is now <span className="font-medium">awaiting customer</span>.
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          <code className="block text-[12px] text-emerald-100 bg-emerald-500/[0.06] border border-emerald-300/25 rounded-lg px-3 py-3 font-mono break-all">
            {fullUrl}
          </code>

          <div className="rounded-lg border border-amber-300/30 bg-amber-500/[0.05] px-3 py-2.5 text-[12px] text-amber-100 leading-relaxed">
            <div className="font-medium text-amber-200 mb-1">
              Shown once
            </div>
            This URL won&apos;t be retrievable after you close this window. Copy
            it now. If you lose it, you&apos;ll need to escalate or wait for the
            customer to respond.
          </div>
        </div>

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            onClick={onCopy}
            className={
              "px-4 py-2.5 rounded-full text-[12px] font-semibold " +
              (copied
                ? "bg-emerald-500 text-black"
                : "bg-white text-black hover:bg-white/90")
            }
          >
            {copied ? "✓ Copied" : "Copy URL"}
          </button>
        </div>
      </div>
    </div>
  );
}
