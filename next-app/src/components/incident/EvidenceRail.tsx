"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type EvidenceItem = {
  id: string;
  sessionId?: string;
  labels?: string[];
  notes?: string;
  file?: {
    originalName?: string;
    storagePath?: string;
    contentType?: string;
  };
  storedAt?: any;
};

export default function EvidenceRail({
  items,
  getReadUrl,
  onSelect,
  highlightId,
  limitLabel,
}: {
  items: EvidenceItem[];
  getReadUrl: (storagePath: string) => Promise<string>;
  onSelect?: (id: string) => void;
  highlightId?: string | null;
  limitLabel?: string;
}) {
  const [urlById, setUrlById] = useState<Record<string, string>>({});
  const [errById, setErrById] = useState<Record<string, boolean>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const safeItems = useMemo(() => Array.isArray(items) ? items.filter(Boolean) : [], [items]);

  useEffect(() => {
    // Resolve a few read URLs quickly for previews
    const run = async () => {
      const next: Record<string, string> = {};
      for (const it of safeItems) {
        const sp = it?.file?.storagePath;
        if (!it?.id || !sp) continue;
        if (urlById[it.id]) continue;
        try {
          const u = await getReadUrl(sp);
          next[it.id] = u;
        } catch {
          // leave blank; fallback tile still shows
        }
      }
      if (!alive.current) return;
      if (Object.keys(next).length) setUrlById((p) => ({ ...p, ...next }));
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeItems.map((x) => x.id).join("|")]);

  const justify = safeItems.length <= 4 ? "justify-center" : "justify-start";

  return (
    <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-gray-400">Evidence</div>
        <div className="text-xs text-gray-500">{limitLabel || `Latest ${Math.min(6, safeItems.length)}`}</div>
      </div>

      <div className="mt-3 text-xs text-gray-500">
        Tap a tile to preview. Timeline events can reference the same evidenceId for quick drill-down.
      </div>

      <div className={"mt-3 flex gap-3 overflow-x-auto pb-2 " + justify}>
        {safeItems.slice(0, 6).map((it) => {
          const active = highlightId && it.id === highlightId;
          const labels = (it.labels || []).slice(0, 2);
          const url = urlById[it.id];
          const bad = !!errById[it.id];

          return (
            <button
              key={it.id}
              onClick={() => onSelect?.(it.id)}
              className={
                "relative group shrink-0 rounded-xl border overflow-hidden text-left " +
                (active ? "border-white/40 ring-2 ring-white/10" : "border-white/10 hover:border-white/20") +
                " bg-black/40"
              }
              style={{ width: 160, height: 96 }}
              title={it.file?.originalName || it.id}
            >
              {/* image */}
              {url && !bad ? (
                <img
                  src={url}
                  className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition"
                  onError={() => setErrById((p) => ({ ...p, [it.id]: true }))}
                  alt={it.file?.originalName || "evidence"}
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/40" />
              )}

              {/* chips */}
              <div className="absolute top-2 left-2 flex gap-1">
                {labels.map((lb) => (
                  <span
                    key={lb}
                    className="px-2 py-0.5 rounded-full text-[10px] border border-white/10 bg-black/50 text-gray-100"
                  >
                    {lb}
                  </span>
                ))}
              </div>

              {/* footer */}
              <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                <div className="text-[10px] text-gray-200 bg-black/50 border border-white/10 rounded px-2 py-0.5 truncate">
                  {it.file?.originalName || it.id.slice(0, 8)}
                </div>
                <div className="text-[10px] text-gray-300 bg-black/50 border border-white/10 rounded px-2 py-0.5">
                  {it.sessionId ? it.sessionId.slice(-6) : "—"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
