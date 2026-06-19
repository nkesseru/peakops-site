// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Customer-facing client orchestrator. Loads the dossier, presents
// the two actions, owns the consume-once state machine.
//
// Light theme on purpose — the customer is a guest, not staff.
// Mobile-first single column.

"use client";

import { useCallback, useEffect, useState } from "react";

import { CustomerReviewDossier } from "@/components/customer/CustomerReviewDossier";
import { AcceptConfirmModal } from "@/components/customer/AcceptConfirmModal";
import { RejectForm } from "@/components/customer/RejectForm";
import { ConsumedTerminalScreen } from "@/components/customer/ConsumedTerminalScreen";
import type {
  CustomerReviewDossierData,
  CustomerReviewPacket,
  GetCustomerReviewResponse,
  SubmitCustomerReviewResponse,
  ConsumedAction,
} from "@/lib/customerReview/types";

type Props = {
  token: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; data: CustomerReviewDossierData; status: string; consumed: boolean; consumedAction: ConsumedAction | null; packet: CustomerReviewPacket | null }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string };

type ActionState =
  | { kind: "idle" }
  | { kind: "accept_modal" }
  | { kind: "reject_form" }
  | { kind: "submitting"; action: ConsumedAction; comment: string }
  | { kind: "done"; action: ConsumedAction; comment: string; recordedAt: string };

export default function CustomerReviewClient({ token }: Props) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });
  const [actionError, setActionError] = useState<string>("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const fetchDossier = useCallback(async () => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    setLoadState({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/fn/getCustomerReviewV1?token=${encodeURIComponent(token)}`,
        { cache: "no-store" }
      );
      const json: GetCustomerReviewResponse = await res.json().catch(() => ({ ok: false }));

      if (res.status === 404) {
        setLoadState({ kind: "not_found" });
        return;
      }
      if (res.status === 410) {
        setLoadState({ kind: "revoked" });
        return;
      }
      if (res.status === 429) {
        setLoadState({ kind: "rate_limited" });
        return;
      }
      if (!res.ok || !json.ok || !json.review) {
        setLoadState({ kind: "error", message: json.error || `Unable to load review (HTTP ${res.status})` });
        return;
      }

      setLoadState({
        kind: "loaded",
        data: json.review,
        status: json.status || "",
        consumed: Boolean(json.consumed),
        consumedAction: (json.consumedAction || null) as ConsumedAction | null,
        // PEAKOPS_REVIEW_VERSION_PIN_V2 (2026-06-15) — null for
        // pre-slice-1 links; dossier/terminal render accordingly.
        packet: json.packet || null,
      });

      // If the link has already been consumed (revisit), show the terminal screen.
      if (json.consumed && json.consumedAction) {
        setActionState({
          kind: "done",
          action: json.consumedAction,
          comment: "",
          recordedAt: "",
        });
      }
    } catch (e: any) {
      setLoadState({ kind: "error", message: e?.message || "Network error" });
    }
  }, [token]);

  useEffect(() => {
    fetchDossier();
  }, [fetchDossier, loadAttempt]);

  const submitAction = useCallback(
    async (action: ConsumedAction, comment: string) => {
      setActionError("");
      setActionState({ kind: "submitting", action, comment });
      try {
        const res = await fetch(`/api/fn/submitCustomerReviewV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: action === "accepted" ? "accept" : "reject",
            comment,
          }),
        });
        const json: SubmitCustomerReviewResponse = await res.json().catch(() => ({ ok: false }));

        if (res.status === 200 && json.ok && json.action) {
          setActionState({
            kind: "done",
            action: json.action,
            comment,
            recordedAt: new Date().toISOString(),
          });
          return;
        }

        if (res.status === 409 && json.error === "already_consumed") {
          // Race: someone else acted on this token. Refresh dossier
          // to show the consumed state cleanly.
          await fetchDossier();
          return;
        }
        if (res.status === 410) {
          setActionError("This review link is no longer valid. Please contact your project coordinator.");
          setActionState({ kind: "idle" });
          setLoadState({ kind: "revoked" });
          return;
        }
        if (res.status === 429) {
          setActionError("Too many attempts. Please wait a moment and try again.");
          setActionState(action === "accepted" ? { kind: "accept_modal" } : { kind: "reject_form" });
          return;
        }
        setActionError(json.detail || json.error || `Submission failed (HTTP ${res.status}).`);
        setActionState(action === "accepted" ? { kind: "accept_modal" } : { kind: "reject_form" });
      } catch (e: any) {
        setActionError(e?.message || "Network error — please try again.");
        setActionState(action === "accepted" ? { kind: "accept_modal" } : { kind: "reject_form" });
      }
    },
    [token, fetchDossier]
  );

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <BrandStrip orgLabel={loadState.kind === "loaded" ? loadState.data.customerLabel : ""} />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-32">
        {loadState.kind === "loading" && (
          <div className="text-center text-sm text-gray-500 py-12">Loading review packet…</div>
        )}

        {loadState.kind === "not_found" && (
          <ErrorPanel
            title="Review link not found"
            body="This review link is no longer valid. Please contact your project coordinator."
          />
        )}

        {loadState.kind === "revoked" && (
          <ErrorPanel
            title="Link no longer valid"
            body="This review link is no longer valid. Please contact your project coordinator."
          />
        )}

        {loadState.kind === "rate_limited" && (
          <ErrorPanel
            title="Too many requests"
            body="Please wait a moment and refresh the page."
            onRetry={() => setLoadAttempt((n) => n + 1)}
          />
        )}

        {loadState.kind === "error" && (
          <ErrorPanel
            title="Couldn't load this packet"
            body={loadState.message}
            onRetry={() => setLoadAttempt((n) => n + 1)}
          />
        )}

        {loadState.kind === "loaded" && actionState.kind !== "done" && (
          <CustomerReviewDossier data={loadState.data} packet={loadState.packet} />
        )}

        {loadState.kind === "loaded" && actionState.kind === "done" && (
          <ConsumedTerminalScreen
            action={actionState.action}
            consumedAtIso={actionState.recordedAt || null}
            comment={actionState.comment || undefined}
            packetTitle={loadState.data.title || undefined}
            packet={loadState.packet}
          />
        )}
      </div>

      {loadState.kind === "loaded" && actionState.kind !== "done" && (
        <ActionBar
          submitting={actionState.kind === "submitting"}
          onAcceptClick={() => {
            setActionError("");
            setActionState({ kind: "accept_modal" });
          }}
          onRejectClick={() => {
            setActionError("");
            setActionState({ kind: "reject_form" });
          }}
        />
      )}

      {actionState.kind === "accept_modal" && loadState.kind === "loaded" && (
        <AcceptConfirmModal
          packetTitle={loadState.data.title || "Review packet"}
          customerLabel={loadState.data.customerLabel}
          templateVersion={loadState.data.templateVersion}
          submitting={false}
          errorMessage={actionError}
          onCancel={() => {
            setActionError("");
            setActionState({ kind: "idle" });
          }}
          onConfirm={(comment) => submitAction("accepted", comment)}
        />
      )}

      {actionState.kind === "submitting" && actionState.action === "accepted" && loadState.kind === "loaded" && (
        <AcceptConfirmModal
          packetTitle={loadState.data.title || "Review packet"}
          customerLabel={loadState.data.customerLabel}
          templateVersion={loadState.data.templateVersion}
          submitting={true}
          errorMessage={actionError}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      )}

      {actionState.kind === "reject_form" && (
        <RejectForm
          submitting={false}
          errorMessage={actionError}
          onCancel={() => {
            setActionError("");
            setActionState({ kind: "idle" });
          }}
          onSubmit={(comment) => submitAction("rejected", comment)}
        />
      )}

      {actionState.kind === "submitting" && actionState.action === "rejected" && (
        <RejectForm
          submitting={true}
          errorMessage={actionError}
          onCancel={() => {}}
          onSubmit={() => {}}
        />
      )}
    </main>
  );
}

function BrandStrip({ orgLabel }: { orgLabel: string }) {
  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-base sm:text-lg font-bold tracking-tight text-gray-900">
            PeakOps
          </span>
          {orgLabel && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-sm text-gray-600">{orgLabel}</span>
            </>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-gray-400">
          Customer review
        </span>
      </div>
    </div>
  );
}

function ActionBar({
  submitting,
  onAcceptClick,
  onRejectClick,
}: {
  submitting: boolean;
  onAcceptClick: () => void;
  onRejectClick: () => void;
}) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-col-reverse sm:flex-row gap-2 sm:gap-3">
        <button
          type="button"
          className="flex-1 px-4 py-3 rounded-full text-sm font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-50"
          onClick={onRejectClick}
          disabled={submitting}
        >
          Request correction
        </button>
        <button
          type="button"
          className="flex-1 px-4 py-3 rounded-full text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
          onClick={onAcceptClick}
          disabled={submitting}
        >
          Accept packet
        </button>
      </div>
    </div>
  );
}

function ErrorPanel({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8 shadow-sm text-center space-y-3">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
      {onRetry && (
        <button
          type="button"
          className="mt-2 px-4 py-2 rounded-full text-sm font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}
