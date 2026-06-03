// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Modal to add a new Recovery Action to a case. Uses the human
// display labels from displayConstants (PR 127a3 includes
// "Provide Test Results" as the 10th type).

"use client";

import { useState } from "react";
import type { RecoveryActionType, OwnerRole } from "@/lib/recovery/types";
import { ACTION_TYPE_DISPLAY, ACTION_TYPE_ORDERED, OWNER_ROLE_DISPLAY } from "@/lib/recovery/displayConstants";

type Props = {
  submitting: boolean;
  errorMessage?: string;
  onCancel: () => void;
  onSubmit: (args: { type: RecoveryActionType; title: string; description?: string; assigneeRole?: OwnerRole }) => void;
};

const OWNER_ROLES: OwnerRole[] = ["coordinator", "supervisor", "field_lead", "manager"];
const TITLE_MAX = 200;
const DESC_MAX = 2000;

export function AddRecoveryActionModal({ submitting, errorMessage, onCancel, onSubmit }: Props) {
  const [type, setType] = useState<RecoveryActionType>("recapture_proof");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeRole, setAssigneeRole] = useState<OwnerRole | "">("");

  const canSubmit = title.trim().length > 0 && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-lg bg-black border border-white/15 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-semibold tracking-tight">Add Recovery Action</h2>
          <p className="text-[12px] text-gray-400 mt-1">
            What does this case need next to unstick the revenue?
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          <label className="block text-[12px] text-gray-300">
            Action type
            <select
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              value={type}
              onChange={(e) => setType(e.target.value as RecoveryActionType)}
              disabled={submitting}
            >
              {ACTION_TYPE_ORDERED.map((t) => (
                <option key={t} value={t}>{ACTION_TYPE_DISPLAY[t]}</option>
              ))}
            </select>
          </label>

          <label className="block text-[12px] text-gray-300">
            Title
            <input
              type="text"
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              placeholder="One-line summary"
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="block text-[12px] text-gray-300">
            Detail (optional)
            <textarea
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 min-h-[80px]"
              placeholder="What specifically needs to be done?"
              maxLength={DESC_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="block text-[12px] text-gray-300">
            Assigned to (optional)
            <select
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              value={assigneeRole}
              onChange={(e) => setAssigneeRole(e.target.value as OwnerRole | "")}
              disabled={submitting}
            >
              <option value="">— unassigned —</option>
              {OWNER_ROLES.map((r) => (
                <option key={r} value={r}>{OWNER_ROLE_DISPLAY[r]}</option>
              ))}
            </select>
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
              type,
              title: title.trim(),
              description: description.trim() || undefined,
              assigneeRole: assigneeRole || undefined,
            })}
            className={
              "px-4 py-2.5 rounded-full text-[12px] font-semibold " +
              (canSubmit ? "bg-white text-black hover:bg-white/90" : "bg-white/10 text-gray-500 cursor-not-allowed")
            }
          >
            {submitting ? "Adding…" : "Add Recovery Action"}
          </button>
        </div>
      </div>
    </div>
  );
}
