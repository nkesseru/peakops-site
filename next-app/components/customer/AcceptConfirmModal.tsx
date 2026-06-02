// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Two-step accept flow. Renders as a full-screen overlay on mobile
// and a centered modal on larger viewports. Comment is optional on
// accept (matches backend PR 126a contract).

"use client";

import { useState } from "react";

type Props = {
  packetTitle: string;
  customerLabel?: string;
  templateVersion?: number | null;
  submitting: boolean;
  errorMessage?: string;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
};

const COMMENT_MAX = 2000;

export function AcceptConfirmModal({
  packetTitle,
  customerLabel,
  templateVersion,
  submitting,
  errorMessage,
  onCancel,
  onConfirm,
}: Props) {
  const [comment, setComment] = useState("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="accept-confirm-title"
    >
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-2">
          <h2
            id="accept-confirm-title"
            className="text-lg font-semibold text-gray-900"
          >
            Confirm acceptance
          </h2>
          <p className="text-sm text-gray-600 mt-1">You&apos;re accepting:</p>
          <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm">
            <div className="font-medium text-gray-800 break-words">{packetTitle}</div>
            {(customerLabel || templateVersion != null) && (
              <div className="text-xs text-gray-600 mt-0.5">
                {customerLabel}
                {templateVersion != null && (
                  <span className="text-gray-500"> · v{templateVersion}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 flex-1 overflow-y-auto">
          <label className="block text-sm text-gray-700 font-medium">
            Comment (optional)
            <textarea
              className="mt-1.5 w-full min-h-[80px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              placeholder="Anything the team should know?"
              maxLength={COMMENT_MAX}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={submitting}
            />
          </label>
          <div className="text-[11px] text-gray-500 mt-1 text-right">
            {comment.length} / {COMMENT_MAX}
          </div>
        </div>

        {errorMessage && (
          <div className="mx-5 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        <div className="px-5 py-4 border-t border-gray-200 bg-gray-50 flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2.5 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              "px-4 py-2.5 rounded-full text-sm font-semibold transition " +
              (submitting
                ? "bg-emerald-300 text-white cursor-wait"
                : "bg-emerald-600 text-white hover:bg-emerald-700")
            }
            onClick={() => onConfirm(comment.trim())}
            disabled={submitting}
          >
            {submitting ? "Recording…" : "Confirm acceptance"}
          </button>
        </div>
      </div>
    </div>
  );
}
