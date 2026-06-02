// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Reject flow. Comment is REQUIRED (matches backend PR 126a contract
// — server returns 400 comment_required when blank, but we validate
// client-side too so the submit button stays disabled until a comment
// is entered).

"use client";

import { useState } from "react";

type Props = {
  submitting: boolean;
  errorMessage?: string;
  onCancel: () => void;
  onSubmit: (comment: string) => void;
};

const COMMENT_MAX = 2000;

export function RejectForm({ submitting, errorMessage, onCancel, onSubmit }: Props) {
  const [comment, setComment] = useState("");
  const trimmed = comment.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-title"
    >
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-2">
          <h2
            id="reject-title"
            className="text-lg font-semibold text-gray-900"
          >
            Request correction
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            Let the team know what needs to change.
          </p>
        </div>

        <div className="px-5 py-3 flex-1 overflow-y-auto">
          <label className="block text-sm text-gray-700 font-medium">
            What needs to be corrected? <span className="text-red-600">*</span>
            <textarea
              className="mt-1.5 w-full min-h-[120px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
              placeholder="Describe what's missing or needs to change…"
              maxLength={COMMENT_MAX}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={submitting}
              required
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
              (canSubmit
                ? "bg-amber-600 text-white hover:bg-amber-700"
                : "bg-gray-300 text-gray-500 cursor-not-allowed")
            }
            onClick={() => onSubmit(trimmed)}
            disabled={!canSubmit}
            title={!trimmed ? "Please enter a comment before submitting" : undefined}
          >
            {submitting ? "Sending…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}
