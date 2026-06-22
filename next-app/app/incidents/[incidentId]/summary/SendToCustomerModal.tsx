// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Coordinator-side modal that mints a customer-review link and shows
// the one-time URL with a Copy button. Backend contract: PR 126a
// createCustomerReviewLinkV1 (returns cleartext token ONCE).
//
// Surfaces:
//   1) Confirm step — "this is one-time, you can't retrieve it later"
//   2) Result step — shows URL, Copy button, sourceStatus, warning
//   3) Error step — surfaces the backend error code with operator hints

"use client";

import { useState } from "react";

import { authedFetch } from "@/lib/apiClient";
import type {
  CreateCustomerReviewLinkResponse,
  SourceStatus,
} from "@/lib/customerReview/types";

type Props = {
  orgId: string;
  incidentId: string;
  // Operator's UID — used as the body.actorUid fallback when the
  // Bearer token path doesn't match (mirrors createCustomerReviewLinkV1
  // _actor.js intentional dual path).
  actorUid?: string;
  onClose: () => void;
};

type StepState =
  | { kind: "confirm" }
  | { kind: "minting" }
  | { kind: "result"; response: CreateCustomerReviewLinkResponse }
  | { kind: "error"; message: string; detail?: string; reasons?: CreateCustomerReviewLinkResponse["reasons"] };

export function SendToCustomerModal({
  orgId,
  incidentId,
  actorUid,
  onClose,
}: Props) {
  const [step, setStep] = useState<StepState>({ kind: "confirm" });
  const [copied, setCopied] = useState(false);

  async function handleMint() {
    setStep({ kind: "minting" });
    try {
      const body: Record<string, unknown> = { orgId, incidentId };
      if (actorUid) body.actorUid = actorUid;

      const res = await authedFetch(`/api/fn/createCustomerReviewLinkV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: CreateCustomerReviewLinkResponse = await res.json().catch(() => ({ ok: false } as CreateCustomerReviewLinkResponse));

      if (res.status === 200 && json.ok) {
        setStep({ kind: "result", response: json });
        return;
      }

      // Common error shapes from PR 126a/c
      let message = "Couldn't mint the review link.";
      if (json.error === "invalid_status_for_review_link") {
        message = "This record isn't ready to be sent for customer review.";
      } else if (json.error === "review_link_blocked_jobs_not_approved") {
        message = "Some jobs on this record aren't approved yet.";
      } else if (json.error === "incident_not_found") {
        message = "Couldn't find this record.";
      } else if (json.error === "permission-denied") {
        message = "You don't have permission to send this record for review.";
      } else if (json.error) {
        message = `${json.error}`;
      }
      setStep({
        kind: "error",
        message,
        detail: json.detail,
        reasons: json.reasons,
      });
    } catch (e: any) {
      setStep({
        kind: "error",
        message: e?.message || "Network error",
      });
    }
  }

  async function copyToClipboard(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / permission issues — surface a fallback hint.
      window.prompt("Copy the URL below:", url);
    }
  }

  // PEAKOPS_REVIEW_MAILTO_HANDOFF_V1 (Chunk 2: Workflow Completion, 2026-06-22)
  // Build a pre-filled mailto: link so the operator can open their
  // email client with one click instead of pasting the URL into a
  // fresh draft manually. The URL stays inline in the body so the
  // customer can copy/paste it on email clients that strip raw URLs.
  // Customer email is not stored on the link doc — the operator
  // supplies the recipient in their own mail client.
  function openInEmailClient(url: string, customerLabel?: string | null) {
    const subject = "Review request — PeakOps field record";
    const body =
      `Hi${customerLabel ? ` ${customerLabel}` : ""},` +
      `\n\n` +
      `Your PeakOps field record is ready for your review:` +
      `\n\n` +
      `${url}` +
      `\n\n` +
      `The link opens in any browser — no login required. Please review and either accept the packet or let us know what needs correction.` +
      `\n\n` +
      `Thank you,` +
      `\nPeakOps`;
    const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    // Use the location-assign path rather than window.open so the
    // user's email client opens in place rather than a popup that
    // some browsers may block.
    try {
      window.location.href = href;
    } catch {
      // Last-resort fallback: copy the URL and tell the operator.
      void copyToClipboard(url);
    }
  }

  const isResult = step.kind === "result";
  const fullUrl = isResult
    ? (typeof window !== "undefined"
      ? `${window.location.origin}${step.response.url || ""}`
      : step.response.url || "")
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="send-to-customer-title"
    >
      <div className="w-full sm:max-w-lg bg-black border border-white/15 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 id="send-to-customer-title" className="text-base font-semibold tracking-tight text-white">
            Send to customer review
          </h2>
          <p className="text-[12px] text-gray-400 mt-1">
            Creates a tokenized URL the customer can open without logging in.
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
          {step.kind === "confirm" && (
            <div className="space-y-3">
              <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] text-gray-300 leading-relaxed">
                You&apos;ll only see the URL <span className="text-white font-medium">once</span>. Copy it before closing the modal — there&apos;s no way to retrieve a lost link without minting a new one (which invalidates the previous one).
              </div>
              <div className="text-[12px] text-gray-400">
                The record will move to <span className="text-white font-medium">Awaiting customer review</span>.
              </div>
            </div>
          )}

          {step.kind === "minting" && (
            <div className="text-center text-[12px] text-gray-400 py-6">Minting review link…</div>
          )}

          {step.kind === "result" && (
            <div className="space-y-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-amber-200/80 font-semibold">
                One-time URL — copy now
              </div>
              <div className="rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2.5">
                <div className="font-mono text-[11px] text-white break-all leading-relaxed">
                  {fullUrl}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  className={
                    "px-4 py-2.5 rounded-full text-[12px] font-semibold transition " +
                    (copied
                      ? "bg-emerald-600 text-white"
                      : "bg-white text-black hover:bg-white/90")
                  }
                  onClick={() => copyToClipboard(fullUrl)}
                >
                  {copied ? "✓ Copied" : "Copy to clipboard"}
                </button>
                {/* PEAKOPS_REVIEW_MAILTO_HANDOFF_V1 (Chunk 2, 2026-06-22)
                    One-click hand-off: opens the operator's default
                    mail client with the subject + body pre-filled and
                    the URL inline. Operator types the recipient and
                    hits send. */}
                <button
                  type="button"
                  className="px-4 py-2.5 rounded-full text-[12px] font-semibold border border-white/15 bg-white/[0.06] text-white hover:bg-white/[0.12]"
                  onClick={() => openInEmailClient(fullUrl, step.response.customerLabel)}
                  title="Open in your email client with the review link pre-filled"
                >
                  ✉ Open in email
                </button>
              </div>
              <div className="rounded-lg border border-amber-300/25 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-200/90 leading-relaxed">
                ⚠ This URL is the credential. Anyone with it can review the packet. Don&apos;t post it to a public channel.
              </div>
              <div className="text-[11px] text-gray-500 space-y-0.5 pt-1">
                <div>
                  <span className="text-gray-600">Source status:</span>{" "}
                  <span className="text-gray-300">{labelForSourceStatus(step.response.sourceStatus)}</span>
                </div>
                {step.response.templateKey && (
                  <div>
                    <span className="text-gray-600">Template:</span>{" "}
                    <span className="text-gray-300 font-mono">{step.response.templateKey}</span>
                    {step.response.templateVersion != null && (
                      <span className="text-gray-600"> v{step.response.templateVersion}</span>
                    )}
                  </div>
                )}
                {step.response.customerLabel && (
                  <div>
                    <span className="text-gray-600">Customer:</span>{" "}
                    <span className="text-gray-300">{step.response.customerLabel}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {step.kind === "error" && (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2.5 text-[12px] text-red-200 leading-relaxed">
                <div className="font-medium text-red-100">{step.message}</div>
                {step.detail && (
                  <div className="text-red-200/80 text-[11px] mt-1">{step.detail}</div>
                )}
              </div>
              {step.reasons && step.reasons.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[11px] text-gray-300">
                  <div className="font-medium text-gray-200 mb-1">Jobs not yet approved:</div>
                  <ul className="space-y-0.5">
                    {step.reasons.map((r, i) => (
                      <li key={i}>
                        <span className="font-mono text-gray-400">{r.jobId}</span>
                        {r.title && <span className="text-gray-400"> — {r.title}</span>}
                        <span className="text-gray-500"> ({r.status || "?"})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          {step.kind === "confirm" && (
            <>
              <button
                type="button"
                className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90"
                onClick={handleMint}
              >
                Mint review link
              </button>
            </>
          )}
          {(step.kind === "result" || step.kind === "error") && (
            <button
              type="button"
              className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90"
              onClick={onClose}
            >
              Close
            </button>
          )}
          {step.kind === "minting" && (
            <button
              type="button"
              className="px-4 py-2.5 rounded-full text-[12px] text-gray-500 cursor-wait"
              disabled
            >
              Minting…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function labelForSourceStatus(s?: SourceStatus): string {
  if (s === "in_progress") return "In progress (modern flow)";
  if (s === "closed") return "Closed (retroactive review)";
  return s || "—";
}
