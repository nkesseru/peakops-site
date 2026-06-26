// PR 135B — Inline capture-gate notice.
//
// Renders above the Submit Session / Mark Complete buttons when the
// incident's readinessCache reports unsatisfied capture-side required
// checks (filtered via captureGateClient.captureRelevantMissing — same
// whitelist the server-side gate uses, so the operator only sees what
// they can actually act on).
//
// Roles:
//   - Field / supervisor / viewer: read-only "you still need:" list.
//   - Owner / admin:                same list + captureGapReason input
//                                   (20-500 chars) + override callback.
//
// The notice does NOT own a submit/complete action button — the parent
// (IncidentClient / JobDetailClient) does, and reads the override
// state from this component via onOverrideChange. Parent decides
// whether the button is enabled and what body fields to send.
//
// Also handles post-flight 412 capture_gate_blocked: parent passes the
// backend's missing[] via the `serverMissing` prop after a failed
// attempt, and the notice prefers that over the cached readiness.
// Defensive — covers a stale readinessCache window.
//
// Mirror of the PR 133C ComplianceGuardModal shape (admin override
// input, reason length floor/ceiling, ackError surfacing). Differs
// in two ways: inline (not modal), and emits override via callback
// (parent owns the button).

"use client";

import { useState } from "react";
import type { ReadinessCache, ReadinessCheck, CaptureGateBlockResponse } from "@/lib/captureGate/types";
import { captureRelevantMissing } from "@/lib/captureGate/captureGateClient";

export type CaptureGateAction = "submit_field_session" | "mark_job_complete";

const ACTION_LABEL: Record<CaptureGateAction, string> = {
  submit_field_session: "submit this session",
  mark_job_complete:    "mark this job complete",
};

const REASON_MIN = 20;
const REASON_MAX = 500;

interface Props {
  /** Pre-flight: cached readiness from the incident doc. */
  readiness?: ReadinessCache | null;
  /** Post-flight: server-returned missing[] from a 412 capture_gate_blocked response. Wins over cached. */
  serverMissing?: CaptureGateBlockResponse["missing"] | null;
  /** Post-flight: backend-reported ackError so we can highlight a stale or rejected reason. */
  ackError?: CaptureGateBlockResponse["ackError"] | null;
  /** Role of the signed-in actor as read from useAuth claims. */
  actorRole?: string | null;
  /** Which lifecycle button this notice sits above. */
  action: CaptureGateAction;
  /** Notify parent of override-reason state so it can include the fields when firing the action. */
  onOverrideChange?: (override: { reason: string } | null) => void;
  /** Optional className for layout tweaks at the call site. */
  className?: string;
}

function _shapeMissing(
  serverMissing: Props["serverMissing"],
  readiness: ReadinessCache | null | undefined,
): Array<{ key: string; label: string; detail?: string | null }> {
  if (serverMissing && serverMissing.length > 0) {
    return serverMissing.map((m) => ({
      key: String(m.key || ""),
      label: String(m.label || m.key || "(missing item)"),
      detail: m.detail ?? null,
    }));
  }
  return captureRelevantMissing(readiness).map((c: ReadinessCheck) => ({
    key: c.key,
    label: c.label,
    detail: c.detail ?? null,
  }));
}

export function CaptureGateNotice({
  readiness,
  serverMissing,
  ackError,
  actorRole,
  action,
  onOverrideChange,
  className,
}: Props) {
  const missing = _shapeMissing(serverMissing, readiness);
  const [reason, setReason] = useState("");

  // Empty list → render nothing. The parent should also gate on this
  // via captureGateShouldDisable, but rendering nothing is the safe
  // fallback if something gets out of sync.
  if (missing.length === 0) return null;

  const isAdmin = actorRole === "owner" || actorRole === "admin";
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;

  function emitOverride(next: string) {
    setReason(next);
    if (!onOverrideChange) return;
    const t = next.trim();
    onOverrideChange(t.length >= REASON_MIN && t.length <= REASON_MAX ? { reason: t } : null);
  }

  return (
    <section
      data-testid="capture-gate-notice"
      data-action={action}
      data-role={actorRole || "unknown"}
      className={
        "rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] p-4 mb-3 " +
        (className || "")
      }
    >
      <div className="flex items-start gap-2 mb-2">
        <span aria-hidden className="text-amber-300 text-[14px] mt-[1px]">⚠</span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-amber-100">
            Before you can {ACTION_LABEL[action]}, you still need:
          </div>
          <p className="text-[11px] text-amber-200/80 mt-0.5">
            PeakOps blocks {action === "submit_field_session" ? "session submit" : "job completion"} until the template&apos;s capture-side requirements are met.
          </p>
        </div>
      </div>

      <ul data-testid="capture-gate-missing-list" className="space-y-1.5 mb-3">
        {missing.map((m) => (
          <li
            key={m.key}
            data-testid="capture-gate-missing-row"
            data-key={m.key}
            className="rounded-lg border border-amber-400/20 bg-amber-500/[0.04] px-3 py-1.5 text-[12px] text-white"
          >
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <span className="font-medium">{m.label}</span>
              {m.detail && <span className="text-[11px] text-amber-200/70">{m.detail}</span>}
            </div>
          </li>
        ))}
      </ul>

      {isAdmin ? (
        <div
          data-testid="capture-gate-admin-override"
          className="rounded-lg border border-amber-300/30 bg-amber-500/[0.05] px-3 py-2.5 space-y-2"
        >
          <label htmlFor="capture-gap-reason" className="block text-[10px] uppercase tracking-[0.16em] font-semibold text-amber-200">
            Admin override — acknowledge capture gap
          </label>
          <p className="text-[11px] text-amber-100/80 leading-relaxed">
            Type {REASON_MIN}-{REASON_MAX} chars explaining why this proceeds despite missing capture. Recorded in the audit trail. Not shown to the customer.
          </p>
          <textarea
            id="capture-gap-reason"
            data-testid="capture-gate-reason-input"
            rows={2}
            maxLength={REASON_MAX}
            placeholder="e.g. Customer pre-approved partial capture for emergency restoration; full photos to follow within 24h."
            className="w-full rounded-md border border-amber-300/30 bg-black/30 px-2.5 py-1.5 text-[12px] text-white placeholder-amber-200/30 focus:outline-none focus:border-amber-300/60"
            value={reason}
            onChange={(e) => emitOverride(e.target.value)}
          />
          <div className="flex justify-between text-[10px] text-amber-100/70">
            <span>{trimmed.length} / {REASON_MAX}</span>
            <span>
              {reasonValid
                ? "Valid — Submit button will use override"
                : `Need ${Math.max(0, REASON_MIN - trimmed.length)} more chars`}
            </span>
          </div>
          {ackError === "override_reason_invalid" && (
            <div data-testid="capture-gate-acked-rejected" className="text-[11px] text-red-300">
              Backend rejected the prior reason as too short or too long.
            </div>
          )}
        </div>
      ) : (
        <div
          data-testid="capture-gate-nonadmin-msg"
          className="rounded-lg border border-amber-300/20 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-amber-100/85"
        >
          Resolve the items above, or ask an admin/owner on your team to handle the submit.
        </div>
      )}
    </section>
  );
}
