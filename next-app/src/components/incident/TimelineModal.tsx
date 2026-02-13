"use client";

import { useMemo, useState } from "react";
import TimelinePanel from "@/components/incident/TimelinePanel";

// Keep props plain so memoization is effective.
export default function TimelineModal(props: {
  items: any[];
  highlightId?: string | null;
  onJumpToEvidence?: (id: string) => void;
}) {
  const { items, highlightId, onJumpToEvidence } = props;
  const [open, setOpen] = useState(false);

  // Small summary: fast to render even if items is huge.
  const summary = useMemo(() => {
    const arr = Array.isArray(items) ? items : [];
    const total = arr.length;
    const sessions = new Set<string>();
    let evidence = 0;
    for (const t of arr) {
      const sid = String(t?.sessionId || "");
      if (sid) sessions.add(sid);
      if (String(t?.type || "") === "EVIDENCE_ADDED") evidence++;
    }
    return { total, sessions: sessions.size, evidence };
  }, [items]);

  return (
    <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-gray-400">Timeline</div>

        <button
          type="button"
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15"
          onClick={() => setOpen(true)}
        >
          View ({summary.total})
        </button>
      </div>

      <div className="mt-2 text-xs text-gray-500 flex flex-wrap gap-2">
        <span className="px-2 py-0.5 rounded-full bg-black/30 border border-white/10">
          Sessions: <span className="text-gray-300">{summary.sessions}</span>
        </span>
        <span className="px-2 py-0.5 rounded-full bg-black/30 border border-white/10">
          Evidence events: <span className="text-gray-300">{summary.evidence}</span>
        </span>
      </div>

      {open ? (
        <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl rounded-2xl bg-black border border-white/10 overflow-hidden shadow-[0_20px_80px_rgba(0,0,0,0.6)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <div className="text-sm text-gray-200">Timeline</div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="p-4 max-h-[80vh] overflow-auto">
              <TimelinePanel items={items as any[]} highlightId={highlightId} onJumpToEvidence={onJumpToEvidence} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
