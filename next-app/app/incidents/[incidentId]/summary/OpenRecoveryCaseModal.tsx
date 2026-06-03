// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Coordinator-side modal: open a Recovery Case manually from inside
// the incident Summary. Visible only when role is admin/owner/
// coordinator AND no active recovery case exists for this incident
// AND incident is in a non-terminal state.
//
// Calls createRecoveryCaseV1 (PR 127a) with source="internal_qc".
// Backend remains source of truth — UI gating is informational.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import type {
  CreateRecoveryCaseResponse,
  RecoveryCausePrimary,
  RevenueType,
} from "@/lib/recovery/types";
import { CAUSE_DISPLAY, CAUSE_ORDERED } from "@/lib/recovery/displayConstants";

type Props = {
  orgId: string;
  incidentId: string;
  actorUid: string;
  onClose: () => void;
};

export function OpenRecoveryCaseModal({ orgId, incidentId, actorUid, onClose }: Props) {
  const router = useRouter();

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const [causePrimary, setCausePrimary] = useState<RecoveryCausePrimary | "">("");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [amount, setAmount] = useState("");
  const [amountType, setAmountType] = useState<RevenueType>("estimated");

  async function handleSubmit() {
    setSubmitting(true);
    setErr("");
    try {
      const body: Record<string, unknown> = {
        orgId,
        incidentId,
        actorUid,
        source: "internal_qc",
      };
      if (causePrimary) {
        body.cause = { primary: causePrimary, operatorNotes: operatorNotes.trim() || undefined };
      } else if (operatorNotes.trim()) {
        body.cause = { operatorNotes: operatorNotes.trim() };
      }
      const amt = Number(amount);
      if (Number.isFinite(amt) && amt > 0) {
        body.revenueAtRisk = { amount: amt, type: amountType };
      } else if (amountType !== "estimated") {
        body.revenueAtRisk = { amount: 0, type: amountType };
      }

      const res = await authedFetch(`/api/fn/createRecoveryCaseV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out: CreateRecoveryCaseResponse = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !out.ok || !out.caseId) {
        throw new Error(out.detail || out.error || `HTTP ${res.status}`);
      }
      router.push(`/recovery/${out.caseId}?orgId=${encodeURIComponent(orgId)}`);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-lg bg-black border border-white/15 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-semibold tracking-tight text-white">Open recovery case</h2>
          <p className="text-[12px] text-gray-400 mt-1">
            Track revenue at risk and recovery work for this record.
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          <label className="block text-[12px] text-gray-300">
            What&apos;s wrong (cause)
            <select
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              value={causePrimary}
              onChange={(e) => setCausePrimary(e.target.value as RecoveryCausePrimary | "")}
              disabled={submitting}
            >
              <option value="">— not yet triaged —</option>
              {CAUSE_ORDERED.map((c) => (
                <option key={c} value={c}>{CAUSE_DISPLAY[c]}</option>
              ))}
            </select>
            <div className="text-[11px] text-gray-500 mt-1">
              Picking a cause now auto-triages the case to <span className="text-gray-300">triaged</span> instead of <span className="text-gray-300">open</span>.
            </div>
          </label>

          <label className="block text-[12px] text-gray-300">
            Operator notes (optional)
            <textarea
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 min-h-[60px]"
              placeholder="What needs attention?"
              maxLength={2000}
              value={operatorNotes}
              onChange={(e) => setOperatorNotes(e.target.value)}
              disabled={submitting}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-gray-300">
              Revenue at risk (USD)
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 tabular-nums"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={submitting}
              />
            </label>
            <label className="block text-[12px] text-gray-300">
              Confidence
              <select
                className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
                value={amountType}
                onChange={(e) => setAmountType(e.target.value as RevenueType)}
                disabled={submitting}
              >
                <option value="actual">Actual</option>
                <option value="estimated">Estimated</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
          </div>
          <div className="text-[11px] text-gray-500">
            For internal tracking only. Not an invoice.
          </div>
        </div>

        {err && (
          <div className="mx-5 mb-3 rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
            {err}
          </div>
        )}

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleSubmit}
            className="px-4 py-2.5 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90 disabled:opacity-50"
          >
            {submitting ? "Opening…" : "Open recovery case"}
          </button>
        </div>
      </div>
    </div>
  );
}
