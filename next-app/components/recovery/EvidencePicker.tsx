// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Evidence Picker MVP. Per PR 127b planning override #12:
// "Recovery is about attaching the missing thing, not describing it."
//
// Queries listEvidenceLocker (existing callable) scoped to the
// case's incidentId. Multi-select with checkboxes. Returns evidence
// ids to parent on confirm.

"use client";

import { useEffect, useMemo, useState } from "react";
import { authedFetch } from "@/lib/apiClient";

type EvidenceItem = {
  id: string;
  filename?: string;
  fileName?: string;
  originalFilename?: string;
  caption?: string;
  description?: string;
  slotKey?: string;
  requirementKey?: string;
  capturedAt?: any;
};

type Props = {
  orgId: string;
  incidentId: string;
  alreadyAttachedIds?: string[];
  onCancel: () => void;
  onConfirm: (selectedIds: string[]) => void;
  submitting?: boolean;
};

function pickFilename(e: EvidenceItem): string {
  return String(e.filename || e.fileName || e.originalFilename || "Proof item").trim();
}

function pickCaption(e: EvidenceItem): string {
  return String(e.caption || e.description || "").trim();
}

function pickSlot(e: EvidenceItem): string {
  return String(e.slotKey || e.requirementKey || "").trim();
}

export function EvidencePicker({ orgId, incidentId, alreadyAttachedIds = [], onCancel, onConfirm, submitting = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const alreadyAttached = useMemo(() => new Set(alreadyAttachedIds), [alreadyAttachedIds]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out?.error || `HTTP ${res.status}`);
        if (cancelled) return;
        const arr = Array.isArray(out.evidence) ? out.evidence : Array.isArray(out.items) ? out.items : [];
        setItems(arr);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Couldn't load evidence.");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, incidentId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCount = selected.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-2xl bg-black border border-white/15 rounded-t-2xl sm:rounded-2xl shadow-xl text-white flex flex-col max-h-[90vh] overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-semibold tracking-tight text-white">Attach evidence</h2>
          <p className="text-[12px] text-gray-400 mt-1">
            Select existing evidence from this incident&apos;s locker.
          </p>
        </div>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-2">
          {loading && <div className="text-[12px] text-gray-500 italic py-6 text-center">Loading evidence…</div>}
          {err && <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">{err}</div>}
          {!loading && !err && items.length === 0 && (
            <div className="text-[12px] text-gray-500 italic py-6 text-center">No evidence in this incident&apos;s locker yet.</div>
          )}
          {items.map((item) => {
            const isSelected = selected.has(item.id);
            const isAttached = alreadyAttached.has(item.id);
            return (
              <label
                key={item.id}
                className={
                  "block rounded-lg border px-3 py-2.5 cursor-pointer transition " +
                  (isAttached
                    ? "border-white/10 bg-white/[0.02] opacity-60 cursor-not-allowed"
                    : isSelected
                      ? "border-emerald-400/40 bg-emerald-500/[0.06]"
                      : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]")
                }
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isAttached}
                    onChange={() => toggle(item.id)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-medium break-all">{pickFilename(item)}</div>
                    {pickCaption(item) && (
                      <div className="text-[12px] text-gray-400 mt-0.5">{pickCaption(item)}</div>
                    )}
                    <div className="text-[11px] text-gray-500 mt-0.5 space-x-2 font-mono">
                      {pickSlot(item) && <span>slot: {pickSlot(item)}</span>}
                      <span>id: {item.id.slice(0, 8)}</span>
                      {isAttached && <span className="text-emerald-300/70">(already attached)</span>}
                    </div>
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t border-white/10 bg-white/[0.02] flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
          <div className="text-[11px] text-gray-400">
            {selectedCount} selected
          </div>
          <div className="flex gap-2 sm:gap-3">
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
              disabled={selectedCount === 0 || submitting}
              onClick={() => onConfirm(Array.from(selected))}
              className={
                "px-4 py-2.5 rounded-full text-[12px] font-semibold " +
                (selectedCount === 0
                  ? "bg-white/10 text-gray-500 cursor-not-allowed"
                  : "bg-white text-black hover:bg-white/90")
              }
            >
              {submitting ? "Attaching…" : `Attach ${selectedCount || ""}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
