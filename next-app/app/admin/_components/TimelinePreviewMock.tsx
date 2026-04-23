"use client";

import React, { useEffect, useMemo, useState } from "react";

type TimelineDoc = {
  id: string;
  type?: string;
  title?: string;
  message?: string;
  occurredAt?: string;
  createdAt?: string;
};

type ApiResp =
  | { ok: true; orgId: string; incidentId: string; count: number; docs: TimelineDoc[] }
  | { ok: false; error: string };

function pill(): React.CSSProperties {
  return {
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid #1a1a1a",
    background: "#0a0a0a",
    color: "#888",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",
  };
}

function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try {
    return { ok: true, v: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e) };
  }
}

function toMs(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function relLabel(ms: number | null, base: number | null) {
  if (ms == null || base == null) return "";
  const diff = ms - base;
  const mins = Math.round(diff / 60000);
  if (mins === 0) return "T+0";
  return mins > 0 ? `T+${mins}m` : `T${mins}m`;
}

const FALLBACK: TimelineDoc[] = [
  { id: "t0_created", title: "Incident created", message: "Basic incident record exists.", occurredAt: "T+0" },
  { id: "t1_timeline", title: "Timeline generated", message: "Events ordered oldest → newest.", occurredAt: "T+5m" },
  { id: "t2_filings", title: "Filings generated", message: "DIRS / OE-417 / NORS / SAR / BABA payloads created.", occurredAt: "T+10m" },
  { id: "t3_export", title: "Packet exported", message: "ZIP + hashes produced for audit.", occurredAt: "T+15m" },
];

export default function TimelinePreviewMock(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [docs, setDocs] = useState<TimelineDoc[] | null>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&limit=200`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();

      if (!text || !text.trim()) throw new Error(`Timeline API returned empty body (HTTP ${r.status})`);

      const parsed = safeJson(text);
      if (!parsed.ok) {
        const sample = text.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`Timeline API returned non-JSON (HTTP ${r.status}): ${parsed.err} — ${sample}`);
      }

      const j = parsed.v as ApiResp;
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "getTimelineEventsV1 failed"));

      const list = Array.isArray((j as any)?.docs) ? ((j as any).docs as TimelineDoc[]) : [];
      setDocs(list);
    } catch (e: any) {
      setDocs(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  const view = useMemo(() => {
    const list = docs && docs.length ? docs : null;
    if (!list) return null;

    const sorted = [...list].sort((a, b) => {
      const am = toMs(a.occurredAt) ?? toMs(a.createdAt) ?? 0;
      const bm = toMs(b.occurredAt) ?? toMs(b.createdAt) ?? 0;
      return am - bm;
    });

    const base = sorted.length ? (toMs(sorted[0].occurredAt) ?? toMs(sorted[0].createdAt)) : null;
    return { sorted, base };
  }, [docs]);

  const showFallback = !view && !err;

  return (
    <div style={{ border: "1px solid #1a1a1a", borderRadius: 8, background: "#0a0a0a", padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>Timeline</span>
          <span style={{ fontSize: 10, color: "#555" }}>
            {err ? "Error" : view ? `${view.sorted.length} events` : showFallback ? "Mock" : "—"}
          </span>
        </div>
        <button onClick={load} disabled={busy} style={pill()}>
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: 4, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#fca5a5", fontSize: 11 }}>
          {err}
        </div>
      )}

      {(view?.sorted || (showFallback ? FALLBACK : [])).length > 0 && (
        <div style={{ marginTop: 8, border: "1px solid #1a1a1a", borderRadius: 6, overflow: "hidden", maxHeight: 200, overflowY: "auto" }}>
          {(view?.sorted || (showFallback ? FALLBACK : [])).map((ev, i, arr) => {
            const ms = toMs(ev.occurredAt) ?? toMs(ev.createdAt);
            const label =
              view?.base != null
                ? relLabel(ms, view.base)
                : (typeof ev.occurredAt === "string" && ev.occurredAt.startsWith("T+"))
                  ? ev.occurredAt
                  : "";

            return (
              <div key={String(ev.id || i)} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 10px", borderBottom: i < arr.length - 1 ? "1px solid #111" : "none", background: "#050505" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#ccc" }}>{ev.title || ev.type || ev.id}</span>
                <span style={{ fontSize: 10, color: "#444" }}>{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
