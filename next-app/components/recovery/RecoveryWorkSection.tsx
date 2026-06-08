// PEAKOPS_RECOVERY_FOREMAN_UI_V1 (PR 130b)
//
// Surfaces recovery actions inside the field incident view as
// "Extra work needed before this can be accepted." The field user
// never sees:
//   - the words "recovery", "case", "resubmission", "packet"
//   - revenue at risk, customer rejection comments, cause taxonomy
//   - coordinator audit data
//
// Architecture lock (PR 129 review, locked 2026-06-05):
//   Foreman should ONLY see: Problem → Location → Action → Done.
//
// Wedge guards (UI side):
//   - Hidden completely when backend returns zero visible items.
//   - Status-changing buttons (Start / Mark done) call the narrow
//     completeRecoveryFieldWorkV1 wrapper. Coordinator's
//     updateRecoveryActionV1 endpoint is NOT used here.
//   - Attach proof is a router push to the existing /add-evidence
//     page. No new evidence upload surface, no pre-attach plumbing —
//     foreman uploads to the incident locker and (for MVP) the
//     coordinator-side EvidencePicker is used to link evidence to
//     the action. Query-param pre-attach is a follow-up PR.
//
// IMPORTANT: The only import allowed from lib/recovery/* is
// ACTION_TYPE_DISPLAY (the human label map). Do NOT import status
// displays, cause displays, or RecoveryCase types — those carry
// vocabulary the field user must never see.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import { ACTION_TYPE_DISPLAY } from "@/lib/recovery/displayConstants";
import type {
  ForemanOpenWorkItem,
  ListForemanWorkResponse,
  CompleteForemanWorkResponse,
} from "@/lib/recovery/foreman.types";

type Props = {
  orgId: string;
  incidentId: string;
  /** Parent's refresh callback. Called after any state-changing write
      so the broader incident view re-pulls timeline + evidence + jobs. */
  onWorkChanged?: () => void;
};

export function RecoveryWorkSection({ orgId, incidentId, onWorkChanged }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const actorUid = String(user?.uid || "").trim();

  const [items, setItems] = useState<ForemanOpenWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");
  const [busyActionId, setBusyActionId] = useState<string>("");
  const [opErr, setOpErr] = useState<string>("");
  const [refreshTick, setRefreshTick] = useState(0);

  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (!orgId || !incidentId || !actorUid) return;
    let cancelled = false;
    setLoading(true);
    setErr("");
    (async () => {
      try {
        const url = `/api/fn/listRecoveryActionsForIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: ListForemanWorkResponse = await res.json().catch(() => ({ ok: false }));
        if (cancelled) return;
        if (!res.ok || !out.ok) {
          setErr(out.error || `HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        setItems(Array.isArray(out.openWork) ? out.openWork : []);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Failed to load");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, incidentId, actorUid, refreshTick]);

  async function callComplete(actionId: string, body: Record<string, unknown>) {
    setBusyActionId(actionId);
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/completeRecoveryFieldWorkV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, incidentId, actionId, actorUid, ...body }),
      });
      const out: CompleteForemanWorkResponse = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !out.ok) {
        // Surface server detail so the foreman knows *something* went
        // wrong without exposing internals. "Not authorized" is the
        // most likely friendly mapping for 403.
        const msg = out.detail || out.error || `Couldn't update (HTTP ${res.status})`;
        throw new Error(msg);
      }
      refetch();
      onWorkChanged?.();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    } finally {
      setBusyActionId("");
    }
  }

  // PR 130b — MVP: routing to the existing add-evidence flow. The
  // foreman uploads evidence to the incident locker; coordinator side
  // can pick it up via the existing EvidencePicker modal. Query-param
  // pre-attach is a follow-up.
  function attachProof(_actionId: string) {
    router.push(`/incidents/${encodeURIComponent(incidentId)}/add-evidence`);
  }

  // Hidden when empty — the architecture lock requires the foreman to
  // not even know this surface exists when there's nothing to do.
  if (!loading && !err && items.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-300/25 bg-amber-400/[0.06] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-amber-200/85 font-semibold">
          Extra work needed before this can be accepted
        </div>
        {items.length > 1 && (
          <span className="text-[11px] text-amber-100/65">{items.length} items</span>
        )}
      </div>

      {loading && (
        <div className="text-[12px] text-amber-100/60 italic">Loading…</div>
      )}

      {err && (
        <div className="rounded-lg border border-red-300/25 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-200 flex items-center justify-between gap-2">
          <span>Couldn&apos;t load extra work: {err}</span>
          <button
            type="button"
            className="text-[11px] underline hover:text-red-100"
            onClick={refetch}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !err && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((item) => {
            const typeLabel = ACTION_TYPE_DISPLAY[item.type as keyof typeof ACTION_TYPE_DISPLAY] || item.type;
            const isBusy = busyActionId === item.id;
            const assignedToMe = item.assignee === actorUid;
            return (
              <li
                key={item.id}
                className="rounded-xl bg-black/40 border border-amber-300/15 p-3 sm:p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm sm:text-base font-semibold text-white">
                        {typeLabel}
                      </span>
                      <StatusPill status={item.status} />
                      {assignedToMe && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-200 bg-amber-400/15 border border-amber-300/30 rounded-full px-2 py-0.5">
                          Assigned to you
                        </span>
                      )}
                    </div>
                    {item.title && item.title !== typeLabel && (
                      <div className="text-[13px] text-amber-50/90 leading-snug">
                        {item.title}
                      </div>
                    )}
                  </div>
                </div>

                {item.description && (
                  <div className="text-[13px] text-gray-200 leading-relaxed">
                    {item.description}
                  </div>
                )}

                {item.evidenceCount > 0 && (
                  <div className="text-[11px] text-amber-200/70">
                    {item.evidenceCount} proof{item.evidenceCount === 1 ? "" : "s"} attached
                  </div>
                )}

                {item.status === "blocked" && item.blockingReason && (
                  <div className="rounded-lg border border-rose-300/30 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-rose-100">
                    Held up: {item.blockingReason}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  {item.status === "open" && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => callComplete(item.id, { status: "in_progress" })}
                      className="px-4 py-2 rounded-full text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isBusy ? "…" : "Start"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => attachProof(item.id)}
                    className="px-4 py-2 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10]"
                  >
                    Attach proof
                  </button>
                  {item.status !== "blocked" && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => callComplete(item.id, { status: "done" })}
                      className="px-4 py-2 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isBusy ? "Saving…" : "Mark done"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {opErr && (
        <div className="rounded-lg border border-red-300/25 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-200">
          {opErr}
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  // PR 130b — tiny inline pills. Decoupled from
  // lib/recovery/displayConstants.ts ACTION_STATUS_DISPLAY by design
  // — that map carries admin terminology ("Open" / "In progress"
  // here is plain field language; happens to match, but the
  // independence keeps the architecture lock clean).
  const className =
    status === "in_progress"
      ? "bg-blue-500/15 text-blue-200 border-blue-400/30"
      : status === "blocked"
        ? "bg-rose-500/15 text-rose-200 border-rose-400/30"
        : "bg-gray-500/15 text-gray-200 border-gray-400/30";
  const label =
    status === "in_progress" ? "In progress" : status === "blocked" ? "Held up" : "Open";
  return (
    <span
      className={`inline-flex items-center rounded-full border text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 ${className}`}
    >
      {label}
    </span>
  );
}
