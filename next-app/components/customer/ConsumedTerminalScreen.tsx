// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Terminal receipt screen shown:
//   - immediately after a successful Accept or Reject
//   - when the customer re-visits a link they've already acted on
//
// Per PR 126b plan: receipt is shown PERMANENTLY (no expiration on view).
// Customer always has a record of what they did and when.

"use client";

import type { ConsumedAction } from "@/lib/customerReview/types";

type Props = {
  action: ConsumedAction;
  consumedAtIso?: string | null;
  comment?: string;
  packetTitle?: string;
};

function fmtIso(iso: string | null | undefined): string {
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

export function ConsumedTerminalScreen({ action, consumedAtIso, comment, packetTitle }: Props) {
  const accepted = action === "accepted";
  const headlineColor = accepted ? "emerald" : "amber";
  const headline = accepted
    ? "Acceptance recorded"
    : "Correction request sent";
  const subtext = accepted
    ? "Thank you. The team has been notified of your acceptance."
    : "Thank you. The team has been notified of your feedback.";

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-7 shadow-sm space-y-4">
      <div className="flex items-start gap-3">
        <span
          className={
            "flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full text-2xl " +
            (headlineColor === "emerald"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-700")
          }
        >
          {accepted ? "✓" : "↺"}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold text-gray-900 leading-tight">
            {headline}
          </h2>
          <p className="text-sm text-gray-600 mt-1">{subtext}</p>
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-gray-200">
        {packetTitle && (
          <div className="text-sm text-gray-700">
            <span className="text-gray-500">Packet:</span>{" "}
            <span className="font-medium text-gray-800 break-words">{packetTitle}</span>
          </div>
        )}
        {consumedAtIso && (
          <div className="text-sm text-gray-700">
            <span className="text-gray-500">Recorded:</span>{" "}
            <span className="text-gray-800">{fmtIso(consumedAtIso)}</span>
          </div>
        )}
        {comment && (
          <div className="text-sm text-gray-700">
            <div className="text-gray-500 mb-1">Your comment:</div>
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm text-gray-800 whitespace-pre-line break-words">
              {comment}
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500 pt-3 border-t border-gray-200">
        If you need to revise your response, please contact your project coordinator.
      </div>
    </div>
  );
}
