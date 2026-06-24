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

import { useEffect, useRef, useState } from "react";

import { authedFetch } from "@/lib/apiClient";
import type {
  CreateCustomerReviewLinkResponse,
  SourceStatus,
} from "@/lib/customerReview/types";
// PR 133B — recognize 412 compliance_block and surface code-level detail.
import type { ComplianceBlockResponse } from "@/lib/compliance/types";
import { explainCode } from "@/lib/compliance/complianceCopy";

type Props = {
  orgId: string;
  incidentId: string;
  // Operator's UID — used as the body.actorUid fallback when the
  // Bearer token path doesn't match (mirrors createCustomerReviewLinkV1
  // _actor.js intentional dual path).
  actorUid?: string;
  // PR 133B — caller passes the actor's role so the modal can decide
  // whether to render the admin-only override reason input on a
  // compliance_block response.
  actorRole?: string;
  // PR 133B (verify-fix) — admin override reason collected by the
  // upstream ComplianceGuardModal in the pre-flight gate. When set,
  // the modal skips the confirm step and immediately calls
  // createCustomerReviewLinkV1 with the override fields populated.
  // Prevents the operator from being prompted for the reason twice
  // (once in the guard, again here after a 412 round-trip).
  pendingOverride?: { reason: string } | null;
  onClose: () => void;
};

const OVERRIDE_REASON_MIN = 20;
const OVERRIDE_REASON_MAX = 500;

type StepState =
  | { kind: "confirm" }
  | { kind: "minting" }
  | { kind: "result"; response: CreateCustomerReviewLinkResponse }
  | { kind: "error"; message: string; detail?: string; reasons?: CreateCustomerReviewLinkResponse["reasons"] }
  // PR 133B — dedicated compliance_block state. Carries the codes the
  // backend returned + (when admin) lets the operator type an override
  // reason and re-fire the mint.
  | { kind: "compliance_block"; payload: ComplianceBlockResponse; reason: string };

export function SendToCustomerModal({
  orgId,
  incidentId,
  actorUid,
  actorRole,
  pendingOverride,
  onClose,
}: Props) {
  const [step, setStep] = useState<StepState>({ kind: "confirm" });
  const [copied, setCopied] = useState(false);
  const isAdmin = actorRole === "owner" || actorRole === "admin";
  // Guard against StrictMode double-invocation of the mount effect —
  // we must only auto-mint the pending override once per modal open.
  const autoMintedRef = useRef(false);

  // PR 133B (verify-fix) — if a pending override was handed in by the
  // upstream pre-flight ComplianceGuardModal, auto-skip the confirm
  // step and propagate the reason into the mint call. This is the
  // single source of truth for the override reason — the operator
  // should never have to type it twice.
  useEffect(() => {
    if (autoMintedRef.current) return;
    if (pendingOverride && pendingOverride.reason && pendingOverride.reason.trim().length > 0) {
      autoMintedRef.current = true;
      void handleMint(pendingOverride.reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOverride]);

  async function handleMint(overrideReason?: string) {
    setStep({ kind: "minting" });
    try {
      const body: Record<string, unknown> = { orgId, incidentId };
      if (actorUid) body.actorUid = actorUid;
      // PR 133B — propagate admin override when supplied by the
      // compliance_block branch's "Send anyway" button.
      const trimmedReason = (overrideReason || "").trim();
      if (trimmedReason) {
        body.acknowledgeViolations = true;
        body.violationAcknowledgmentReason = trimmedReason;
      }

      const res = await authedFetch(`/api/fn/createCustomerReviewLinkV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // PR 133B — recognize 412 compliance_block and route into the
      // dedicated state. Backend response shape from PR 133C.
      if (res.status === 412) {
        const raw = await res.json().catch(() => null);
        if (raw && raw.error === "compliance_block") {
          setStep({
            kind: "compliance_block",
            payload: raw as ComplianceBlockResponse,
            reason: trimmedReason || "",
          });
          return;
        }
      }

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

          {step.kind === "compliance_block" && (
            <div className="space-y-3" data-testid="sendmodal-compliance-block">
              <div className="rounded-lg border border-red-300/30 bg-red-500/[0.06] px-3 py-2.5 text-[12px] text-red-100 leading-relaxed">
                <div className="font-medium">PeakOps blocked this customer review link.</div>
                <div className="text-red-200/80 text-[11px] mt-1">
                  Mode: <span className="font-mono">{step.payload.mode}</span>. {step.payload.codes.length} finding{step.payload.codes.length === 1 ? "" : "s"} unresolved.
                </div>
              </div>
              <ul className="space-y-2">
                {step.payload.codes.map((c, i) => {
                  const copy = explainCode(c.code);
                  const tone = c.severity === "ERROR" ? "border-red-400/30 bg-red-500/[0.05]" : "border-amber-400/30 bg-amber-500/[0.05]";
                  return (
                    <li key={`${c.code}_${i}`} className={"rounded-lg border px-3 py-2 " + tone}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-white">{c.severity === "ERROR" ? "BLOCKING" : "WARNING"}</span>
                        <span className="text-[12px] text-white font-medium">{copy.title}</span>
                        <span className="text-[10px] font-mono text-gray-500">{c.code}</span>
                      </div>
                      <p className="mt-1 text-[12px] text-gray-300 leading-relaxed">{copy.explanation}</p>
                      {copy.action && (
                        <p className="mt-1 text-[11px] text-amber-200/85">
                          <span className="text-amber-300/90 font-semibold">Action:</span> {copy.action}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {!isAdmin && (
                <div data-testid="sendmodal-compliance-nonadmin" className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] text-gray-300">
                  You don&apos;t have permission to override. Resolve the items above, or ask an admin/owner on your team.
                </div>
              )}

              {isAdmin && step.payload.overridable && (
                <div data-testid="sendmodal-compliance-override" className="rounded-lg border border-amber-300/30 bg-amber-500/[0.06] px-3 py-3 space-y-2">
                  <label className="block text-[11px] uppercase tracking-[0.18em] font-semibold text-amber-200">
                    Admin override — acknowledge violations
                  </label>
                  <p className="text-[11px] text-amber-100/80 leading-relaxed">
                    Type a meaningful reason ({OVERRIDE_REASON_MIN}-{OVERRIDE_REASON_MAX} chars). Recorded in the audit trail and packet manifest. Not shown to the customer.
                  </p>
                  <textarea
                    data-testid="sendmodal-compliance-reason"
                    rows={3}
                    maxLength={OVERRIDE_REASON_MAX}
                    placeholder="e.g. Customer pre-approved out-of-band; missing fields filed under interim status."
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-[12px] text-white placeholder-gray-500 focus:outline-none focus:border-amber-300/50"
                    value={step.reason}
                    onChange={(e) => setStep({ kind: "compliance_block", payload: step.payload, reason: e.target.value })}
                  />
                  <div className="text-[10px] text-amber-100/70">{step.reason.trim().length} / {OVERRIDE_REASON_MAX}</div>
                  {step.payload.ackError === "override_reason_invalid" && (
                    <div className="text-[11px] text-red-300">Backend rejected the prior reason as too short or too long.</div>
                  )}
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
                onClick={() => handleMint()}
              >
                Mint review link
              </button>
            </>
          )}
          {step.kind === "compliance_block" && (
            <>
              <button
                type="button"
                className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
                onClick={onClose}
              >
                Cancel
              </button>
              {isAdmin && step.payload.overridable && (
                <button
                  type="button"
                  data-testid="sendmodal-compliance-override-submit"
                  className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-amber-300 hover:bg-amber-200 disabled:bg-amber-300/40"
                  disabled={
                    step.reason.trim().length < OVERRIDE_REASON_MIN ||
                    step.reason.trim().length > OVERRIDE_REASON_MAX
                  }
                  onClick={() => handleMint(step.reason.trim())}
                >
                  Send with admin override
                </button>
              )}
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
