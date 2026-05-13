"use client";

import { useMemo, useState } from "react";

export type TimelineItem = {
  id: string;
  type: string;
  actor?: string;
  refId?: string | null;
  sessionId?: string;
  occurredAt?: { _seconds?: number };
  meta?: any;
};

// PEAKOPS_TIMELINE_HUMANIZE_V1 (2026-04-28)
// Map both upper- and lower-case event types to human copy. Backend
// emits a mix (timelineEmit uses lowercase, older paths use upper).
// Renames "Evidence secured" → "Photos saved" and translates
// job_* → task_* customer-facing.
function prettyType(t: string) {
  const key = String(t || "").toLowerCase();
  const m: Record<string, string> = {
    notes_saved: "Notes saved",
    evidence_added: "Photos saved",
    field_arrived: "Field arrived",
    field_submitted: "Submitted to supervisor",
    field_approved: "Supervisor approved",
    material_added: "Material logged",
    incident_opened: "Incident opened",
    incident_closed: "Incident closed",
    session_started: "Field session started",
    job_created: "Task created",
    job_completed: "Task completed",
    job_approved: "Task approved",
    job_rejected: "Task sent back",
    job_locked: "Task locked",
    supervisor_request_update: "Update requested",
    debug_event: "Debug event",
  };
  if (m[key]) return m[key];
  // Fallback: format as sentence case, swap job → task in the label.
  return key
    .replace(/^job_/, "task_")
    .replace(/_/g, " ")
    .replace(/^./, (x) => x.toUpperCase());
}

// Clock time, no relative seconds. "8:52 AM" beats "34s" for a real
// audit log read by an ops user later.
function fmtClock(sec?: number) {
  if (!sec) return "";
  try {
    return new Date(sec * 1000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function iconFor(t: string) {
  const key = String(t || "").toLowerCase();
  const m: Record<string, string> = {
    evidence_added: "📸",
    field_arrived: "✅",
    field_submitted: "📤",
    field_approved: "🛡️",
    material_added: "🧱",
    incident_opened: "🗂️",
    incident_closed: "✅",
    session_started: "🛰️",
    notes_saved: "📝",
    job_created: "📋",
    job_completed: "✓",
    job_approved: "🛡️",
    job_rejected: "↩︎",
    job_locked: "🔒",
    supervisor_request_update: "💬",
    debug_event: "🧪",
  };
  return m[key] || "•";
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const now = Date.now() / 1000;
  const d = Math.max(0, Math.floor(now - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}function fmtWhen(sec?: number) {
  if (!sec) return "—";
  try {
    return new Date(sec * 1000).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}


const DEFAULT_LIMIT = 10;

export default function TimelinePanel(props: {
  items: TimelineItem[];
  onJumpToEvidence?: (evidenceId: string) => void;
  highlightId?: string | null;
}) {
  const { items, onJumpToEvidence, highlightId } = props;

  // Newest-first
  const sorted = useMemo(
    () =>
      [...(items || [])].sort(
        (a, b) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0)
      ),
    [items]
  );

  // Group by session
  const grouped = useMemo(() => {
    const m = new Map<string, TimelineItem[]>();
    for (const it of sorted) {
      const k = String(it?.sessionId || "no_session");
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    }
    return Array.from(m.entries());
  }, [sorted]);

  // controlled accordion
  const [openSid, setOpenSid] = useState<string>("");
    const [openingSid, setOpeningSid] = useState<string>("");
const [limitBySid, setLimitBySid] = useState<Record<string, number>>({});

  return (
    <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-gray-400">Timeline</div>
        <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">
          Auto-log: On
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {grouped.length === 0 ? (
          <div className="text-sm text-gray-500 py-3">No events yet.</div>
        ) : null}

        {grouped.map(([sid, rows]) => {
          const sec = rows?.[0]?.occurredAt?._seconds || 0;
          const stamp = sec ? new Date(sec * 1000).toLocaleString() : "—";
          const short = sid === "no_session" ? "System" : `Session • ${stamp}`;
const topAge = fmtAgo(rows?.[0]?.occurredAt?._seconds);

          // collapse FIELD_ARRIVED spam (keep first 2)
          let arrivedSeen = 0;
          let arrivedExtra = 0;
          const collapsed: TimelineItem[] = [];
          for (const r of rows) {
            if (String(r?.type || "") === "FIELD_ARRIVED") {
              arrivedSeen += 1;
              if (arrivedSeen > 2) { arrivedExtra += 1; continue; }
            }
          if (arrivedExtra > 0) {
            // PHASE4_3_1_FIELD_ARRIVED_MORE
            collapsed.push({
              id: "FIELD_ARRIVED_MORE_" + String(sid),
              type: "FIELD_ARRIVED_MORE",
              actor: "ui",
              sessionId: sid,
              occurredAt: rows?.[0]?.occurredAt || undefined,
              refId: null,
              meta: { count: arrivedExtra },
            } as any);
          }
            collapsed.push(r);
            if (collapsed.length >= 80) break; // hard cap for UI safety
          }

          const evidence = collapsed.filter(
            (r) => String(r?.type || "") === "EVIDENCE_ADDED"
          );
          const other = collapsed.filter(
            (r) => String(r?.type || "") !== "EVIDENCE_ADDED"
          );

          const isOpen = openSid === sid;
          const limit = Math.min(
            Math.max(1, limitBySid[sid] ?? DEFAULT_LIMIT),
            evidence.length
          );

          return (
            <div
              key={sid}
              className="rounded-2xl bg-black/30 border border-white/10 overflow-hidden"
            >
              <div className="px-3 py-2 flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wide text-gray-500" title={sid}>
                  {short}
                </div>

                <div className="flex items-center gap-2">
                  <div className="text-xs text-gray-500">{topAge}</div>

                  <button disabled={openingSid === sid}
                    type="button"
className="px-2 py-1 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15"
                    onClick={() => {
                      if (isOpen) {
                        setOpenSid("");
                        return;
                      }
                      setOpeningSid(sid);
                      window.setTimeout(() => {
                        setOpenSid(sid);
                        setOpeningSid("");
                      }, 60);
                    }}
                    title={isOpen ? "Hide session" : "Show session"}
                  >
                    {openingSid === sid ? "Opening…" : (isOpen ? "Hide" : "Show")}
                  </button>
                </div>
              </div>

              {/* PEAKOPS_MICRO_SKELETON */}
              {openingSid === sid && !isOpen ? (
                <div className="px-3 pb-3">
                  <div className="mt-2 space-y-2 animate-pulse">
                    <div className="h-10 rounded-xl bg-white/5 border border-white/10" />
                    <div className="h-10 rounded-xl bg-white/5 border border-white/10" />
                  </div>
                </div>
              ) : null}

              {isOpen ? (
                <div className="px-3 pb-3 space-y-2">
                  {/* Evidence list (paged) */}
                  {evidence.length ? (
                    <div className="rounded-xl bg-black/40 border border-white/10 overflow-hidden">
                      <div className="px-3 py-2 flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="text-sm font-semibold truncate">
                            Evidence secured
                          </div>
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-400">
                            x{evidence.length}
                          </span>
                        </div>

                        {evidence.length > limit ? (
                          <button
                            type="button"
className="px-2 py-1 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15"
                            onClick={() =>
                              setLimitBySid((m) => ({
                                ...m,
                                [sid]: Math.min(
                                  (m[sid] ?? DEFAULT_LIMIT) + 10,
                                  evidence.length
                                ),
                              }))
                            }
                          >
                            Load more
                          </button>
                        ) : null}
                      </div>

                      <div className="px-3 pb-3 space-y-2">
                        {evidence.slice(0, limit).map((r) => {
                          const ref = String(r?.refId || "");
                          const canJump = !!(ref && onJumpToEvidence);
                          const isLocked = !!(ref && highlightId === ref);
const hot = !!(highlightId && ref && highlightId === ref);

                          return (
                            <div
                              role={canJump ? "button" : undefined}
                              tabIndex={canJump ? 0 : -1}
                              onClick={canJump ? ((e:any) => {
                                try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
                                onJumpToEvidence?.(ref);
                              }) : undefined}
                              onKeyDown={canJump ? ((e:any) => {
                                try {
                                  const k = String(e?.key || "");
                                  if (k === "Enter" || k === " ") {
                                    e?.preventDefault?.();
                                    onJumpToEvidence?.(ref);
                                  }
                                } catch {}
                              }) : undefined}
                              key={String(r?.id || Math.random())}
                              className={
                                "rounded-xl border px-3 py-2 flex items-center justify-between " +
                                (hot
                                  ? "bg-white/10 border-white/20"
                                  : "bg-black/40 border-white/10") + (canJump ? " cursor-pointer hover:bg-white/10 active:bg-white/15" : "")
                              }
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm">
                                    {iconFor(String(r?.type || ""))}
                                  </span>
                                  <div className="text-sm font-semibold truncate">
                                    {prettyType(String(r?.type || ""))}
                          {String(r?.type || "") === "FIELD_ARRIVED_MORE" ? (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-400">
                              ×{String(((r as any)?.meta?.count) || 0)}
                            </span>
                          ) : null}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <div className="text-xs text-gray-500">
                                  {fmtClock(r?.occurredAt?._seconds) || fmtAgo(r?.occurredAt?._seconds)}
                                </div>
                                {canJump ? (
                                  <button
                                    type="button"
                                    className={"px-2 py-1 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 " + (highlightId && ref && highlightId === ref ? "ring-2 ring-indigo-400/40 border-indigo-300/50" : "")}
                                    onClick={(e:any) => { try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {} onJumpToEvidence?.(ref); }}
                                    title="Jump to related evidence"
                                  >
                                    Jump
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Other events */}
                  {other.map((r) => {
                    const ref = String(r?.refId || "");
                    const canJump = !!(ref && onJumpToEvidence);

                    return (
                      <div
                        key={String(r?.id || Math.random())}
                        className="rounded-xl bg-black/40 border border-white/10 px-3 py-2 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm">{iconFor(String(r?.type || ""))}</span>
                          <div className="text-sm font-semibold truncate">
                            {prettyType(String(r?.type || ""))}
                          </div>
                          {/* PEAKOPS_TIMELINE_HIDE_INTERNAL_V1 (2026-04-28)
                              Hid the "actor" and "ref:" pills from the
                              customer-visible timeline. They surfaced
                              raw "ui" / Firestore doc ids that read as
                              engineer artifacts. The data is still
                              available on the underlying row for
                              support diagnosis (just not rendered). */}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-xs text-gray-500">{fmtClock(r?.occurredAt?._seconds) || fmtAgo(r?.occurredAt?._seconds)}</div>
                          {canJump ? (
                            <button
                              type="button"
                              className={"px-2 py-1 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 " + (highlightId && ref && highlightId === ref ? "ring-2 ring-indigo-400/40 border-indigo-300/50" : "")}
                              onClick={(e:any) => { try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {} onJumpToEvidence?.(ref); }}
                              title="Jump to related evidence"
                            >
                              Jump
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 text-xs text-gray-500">
        Readiness for supervisor review: <span className="text-green-400">Good</span>
      </div>
    </section>
  );
}
