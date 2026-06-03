// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Resolve case modal. Outcome-specific fields:
//   - recovered:        notes optional
//   - partial_recovery: finalAmount REQUIRED + must be 0 < x < baseline
//   - abandoned:        notes optional
// Backend enforces (PR 127a); UI surfaces the error.

"use client";

import { useState } from "react";

type Outcome = "recovered" | "partial_recovery" | "abandoned";

type Props = {
  baselineAmount: number;
  submitting: boolean;
  errorMessage?: string;
  onCancel: () => void;
  onSubmit: (args: { outcome: Outcome; finalAmount?: number; notes?: string }) => void;
};

export function ResolveCaseModal({ baselineAmount, submitting, errorMessage, onCancel, onSubmit }: Props) {
  const [outcome, setOutcome] = useState<Outcome>("recovered");
  const [finalAmount, setFinalAmount] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const finalNum = Number(finalAmount);
  const partialOk = outcome !== "partial_recovery" || (
    Number.isFinite(finalNum) && finalNum > 0 && finalNum < baselineAmount
  );
  const canSubmit = partialOk && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-md bg-black border border-white/15 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-semibold tracking-tight">Resolve recovery case</h2>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          <label className="block text-[12px] text-gray-300">
            Outcome
            <select
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as Outcome)}
              disabled={submitting}
            >
              <option value="recovered">Recovered (full revenue captured)</option>
              <option value="partial_recovery">Partial recovery</option>
              <option value="abandoned">Abandoned (written off)</option>
            </select>
          </label>

          {outcome === "partial_recovery" && (
            <div className="space-y-1">
              <label className="block text-[12px] text-gray-300">
                Final recovered amount (USD)
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 tabular-nums"
                  placeholder={`e.g. ${Math.round(baselineAmount * 0.6)}`}
                  value={finalAmount}
                  onChange={(e) => setFinalAmount(e.target.value)}
                  disabled={submitting}
                />
              </label>
              <div className="text-[11px] text-gray-500">
                Must be greater than 0 and less than baseline ${baselineAmount.toLocaleString()}. Use &quot;Recovered&quot; for full recovery.
              </div>
              {!partialOk && finalAmount && (
                <div className="text-[11px] text-red-300">
                  Invalid amount.
                </div>
              )}
            </div>
          )}

          <label className="block text-[12px] text-gray-300">
            Notes (optional)
            <textarea
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 min-h-[80px]"
              placeholder="Resolution details"
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
            />
          </label>
        </div>

        {errorMessage && (
          <div className="mx-5 mb-3 rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
            {errorMessage}
          </div>
        )}

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2.5 rounded-full text-[12px] text-gray-300 hover:bg-white/[0.06]"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit({
              outcome,
              finalAmount: outcome === "partial_recovery" ? finalNum : undefined,
              notes: notes.trim() || undefined,
            })}
            className={
              "px-4 py-2.5 rounded-full text-[12px] font-semibold " +
              (canSubmit ? "bg-white text-black hover:bg-white/90" : "bg-white/10 text-gray-500 cursor-not-allowed")
            }
          >
            {submitting ? "Resolving…" : "Resolve case"}
          </button>
        </div>
      </div>
    </div>
  );
}
