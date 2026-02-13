"use client";

import { useMemo } from "react";

type Props = {
  reviewMode: boolean;
  approved: boolean;
  ready: boolean;
  missing: string[];
  approving: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onOpenReject: () => void;
};

export default function SupervisorDecisionStrip(props: Props) {
  const {
    reviewMode,
    approved,
    ready,
    missing,
    approving,
    rejecting,
    onApprove,
    onOpenReject,
  } = props;

  const state = useMemo(() => {
    if (!reviewMode) return "hidden";
    if (approved) return "approved";
    if (ready) return "ready";
    return "needs";
  }, [reviewMode, approved, ready]);

  if (state === "hidden") return null;

  const base =
    "sticky top-[64px] z-20 rounded-2xl border px-4 py-3 backdrop-blur " +
    "bg-black/70 ";

  if (state === "approved") {
    return (
      <div className={base + "border-green-400/20"}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-green-300">Approved</div>
            <div className="text-sm text-gray-200">This incident record is locked for audit.</div>
          </div>
          <button
            className="px-3 py-2 rounded-xl bg-green-700/30 border border-green-400/20 text-green-200 text-sm"
            disabled
          >
            ✅ Locked
          </button>
        </div>
      </div>
    );
  }

  const stripTone =
    state === "ready" ? "border-green-400/20" : "border-amber-400/20";

  const titleTone =
    state === "ready" ? "text-green-300" : "text-amber-300";

  const headline =
    state === "ready" ? "Ready to approve" : "Missing items before approval";

  const sub =
    state === "ready"
      ? "Evidence + notes captured. Record is audit-safe and complete."
      : (missing.length ? `Missing: ${missing.join(", ")}` : "Missing: items required for supervisor approval");

  return (
    <div className={base + stripTone}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={"text-xs uppercase tracking-wide " + titleTone}>{headline}</div>
          <div className="text-sm text-gray-200 truncate">{sub}</div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 text-sm hover:bg-white/10 disabled:opacity-50"
            onClick={onOpenReject}
            disabled={rejecting || approving}
            title="Send back to field with specific reasons"
          >
            ↩︎ Send Back
          </button>

          <button
            className={
              "px-3 py-2 rounded-xl text-sm font-semibold border " +
              (state === "ready"
                ? "bg-green-700/25 border-green-400/25 text-green-200 hover:bg-green-700/35"
                : "bg-white/5 border-white/10 text-gray-500")
            }
            onClick={onApprove}
            disabled={approving || state !== "ready"}
            title={state === "ready" ? "Approve & lock the incident record" : "Not ready yet"}
          >
            {approving ? "Approving…" : "🛡 Approve & Lock"}
          </button>
        </div>
      </div>
    </div>
  );
}
