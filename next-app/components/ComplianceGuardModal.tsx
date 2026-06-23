// PR 133B — Pre-flight + post-flight compliance guard modal.
//
// Two roles:
//   1. Pre-flight: SummaryClient calls this when the operator clicks
//      Export Packet or Send to Customer AND the persisted
//      complianceReadiness has blocking findings. Lets the operator
//      see what would fail before the request reaches the backend.
//   2. Post-flight: the same modal is reused when a backend call
//      returns 412 compliance_block with codes — handed the parsed
//      codes[] so the modal can render the same shape.
//
// Override behavior matches backend (PR 133C):
//   - Owner/admin: reason input (20-500 chars) + "Send anyway"
//   - Other roles: read-only explanation, no override input
//   - Caller decides what onConfirm does with the reason (re-fire
//     the request with body.acknowledgeViolations = true +
//     violationAcknowledgmentReason)

"use client";

import { useState } from "react";
import type { ComplianceBlockResponse } from "@/lib/compliance/types";
import { explainCode } from "@/lib/compliance/complianceCopy";

export type GuardAction = "export" | "review_link" | "resubmit";

interface GuardCode {
  code: string;
  severity: "ERROR" | "WARN" | "INFO";
  source?: string;
}

interface Props {
  action: GuardAction;
  // EITHER pre-flight (caller passes codes derived from persisted state)
  // OR post-flight (caller passes the backend's compliance_block payload).
  codes: GuardCode[];
  mode?: string;                  // "block" | "passive_persist" | etc — for messaging only
  overridable?: boolean;          // backend says override is allowed
  actorRole?: string;             // "owner" | "admin" | "supervisor" | "field" | "viewer"
  // Post-flight context (e.g. backend hint copy)
  ackError?: ComplianceBlockResponse["ackError"];
  overrideHint?: string;
  // Callbacks
  onCancel: () => void;
  onConfirm?: (override: { reason: string } | null) => void;  // null = proceed without override (only valid if mode!=block)
}

const ACTION_LABEL: Record<GuardAction, string> = {
  export: "Export packet",
  review_link: "Send to customer",
  resubmit: "Send resubmission",
};

const ACTION_VERB: Record<GuardAction, string> = {
  export: "exporting",
  review_link: "sending to the customer",
  resubmit: "sending a resubmission",
};

const REASON_MIN = 20;
const REASON_MAX = 500;

export function ComplianceGuardModal({
  action,
  codes,
  mode,
  overridable,
  actorRole,
  ackError,
  overrideHint,
  onCancel,
  onConfirm,
}: Props) {
  const isAdmin = actorRole === "owner" || actorRole === "admin";
  const isBlockMode = mode === "block";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const blockerCount = codes.filter((c) => c.severity === "ERROR").length;
  const warnCount = codes.filter((c) => c.severity === "WARN").length;
  const summary = blockerCount > 0
    ? `${blockerCount} blocking finding${blockerCount === 1 ? "" : "s"}${warnCount > 0 ? ` and ${warnCount} warning${warnCount === 1 ? "" : "s"}` : ""}`
    : `${warnCount} warning${warnCount === 1 ? "" : "s"}`;

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length >= REASON_MIN && trimmedReason.length <= REASON_MAX;

  function handleProceedNoOverride() {
    if (!onConfirm) return;
    setBusy(true);
    onConfirm(null);
  }

  function handleProceedWithOverride() {
    if (!onConfirm) return;
    if (!reasonValid) return;
    setBusy(true);
    onConfirm({ reason: trimmedReason });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compliance-guard-title"
      data-testid="compliance-guard-modal"
      data-action={action}
      data-mode={mode || "unknown"}
      data-actor-role={actorRole || "unknown"}
    >
      <div className="w-full sm:max-w-xl bg-black border border-red-400/30 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 id="compliance-guard-title" className="text-base font-semibold tracking-tight text-white">
            {ACTION_LABEL[action]} — compliance review
          </h2>
          <p className="text-[12px] text-gray-400 mt-1">
            PeakOps found {summary} on this record before {ACTION_VERB[action]}.
            {isBlockMode
              ? " This org is in enforcement mode — proceeding requires an admin override."
              : " You can still proceed; the customer may flag these on review."}
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          <ul className="space-y-2" data-testid="compliance-guard-codes">
            {codes.map((c, i) => {
              const copy = explainCode(c.code);
              const tone = c.severity === "ERROR" ? "border-red-400/30 bg-red-500/[0.05]" : c.severity === "WARN" ? "border-amber-400/30 bg-amber-500/[0.05]" : "border-sky-400/25 bg-sky-500/[0.05]";
              const sevLabel = c.severity === "ERROR" ? "BLOCKING" : c.severity === "WARN" ? "WARNING" : "INFO";
              return (
                <li key={`${c.code}_${i}`} data-testid="compliance-guard-row" data-severity={c.severity} className={"rounded-lg border px-3 py-2 " + tone}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-white">{sevLabel}</span>
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

          {isBlockMode && !isAdmin && (
            <div data-testid="compliance-guard-nonadmin" className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] text-gray-300 leading-relaxed">
              You don&apos;t have permission to override compliance blocks. Resolve the items above, or ask an admin/owner on your team to send this on your behalf.
            </div>
          )}

          {isBlockMode && isAdmin && overridable && (
            <div data-testid="compliance-guard-override" className="rounded-lg border border-amber-300/30 bg-amber-500/[0.06] px-3 py-3 space-y-2">
              <label htmlFor="violation-ack-reason" className="block text-[11px] uppercase tracking-[0.18em] font-semibold text-amber-200">
                Admin override — acknowledge violations
              </label>
              <p className="text-[11px] text-amber-100/80 leading-relaxed">
                Type a meaningful reason ({REASON_MIN}-{REASON_MAX} characters). This is recorded in the audit trail and embedded in the packet manifest. It is <span className="font-semibold">not</span> shown to the customer.
              </p>
              <textarea
                id="violation-ack-reason"
                data-testid="compliance-guard-reason-input"
                rows={3}
                maxLength={REASON_MAX}
                placeholder="e.g. Operator review confirms missing affectedCustomers is non-applicable to this internal test scenario."
                className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-[12px] text-white placeholder-gray-500 focus:outline-none focus:border-amber-300/50"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex justify-between text-[10px] text-amber-100/70">
                <span>{trimmedReason.length} / {REASON_MAX}</span>
                <span>{reasonValid ? "Length OK" : `Need ${Math.max(0, REASON_MIN - trimmedReason.length)} more chars`}</span>
              </div>
              {ackError === "override_reason_invalid" && (
                <div className="text-[11px] text-red-300">Backend rejected the prior reason as too short or too long.</div>
              )}
            </div>
          )}

          {overrideHint && (
            <p className="text-[10px] text-gray-500 italic">{overrideHint}</p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
            onClick={onCancel}
            disabled={busy}
            data-testid="compliance-guard-cancel"
          >
            Cancel
          </button>
          {!isBlockMode && onConfirm && (
            <button
              type="button"
              className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90 disabled:bg-white/40"
              onClick={handleProceedNoOverride}
              disabled={busy}
              data-testid="compliance-guard-proceed"
            >
              {busy ? "Sending…" : `Continue with ${ACTION_LABEL[action].toLowerCase()}`}
            </button>
          )}
          {isBlockMode && isAdmin && overridable && onConfirm && (
            <button
              type="button"
              className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-amber-300 hover:bg-amber-200 disabled:bg-amber-300/40"
              onClick={handleProceedWithOverride}
              disabled={!reasonValid || busy}
              data-testid="compliance-guard-override-submit"
            >
              {busy ? "Sending…" : `${ACTION_LABEL[action]} with admin override`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
