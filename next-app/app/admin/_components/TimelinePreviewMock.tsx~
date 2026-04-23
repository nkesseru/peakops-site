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

function frame(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

function pill(): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
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
        `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
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
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "getTimelineEvents failed"));

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
    <details style={{ marginTop: 10 }} open={false}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
        Timeline Preview {showFallback ? "(mock)" : ""}
      </summary>

      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {err
            ? "Error loading timeline."
            : view
              ? `${view.sorted.length} events · oldest → newest`
              : "No events yet — showing mock preview."}
        </div>
        <button onClick={load} disabled={busy} style={pill()}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
        {(view?.sorted || (showFallback ? FALLBACK : [])).map((ev, i) => {
          const ms = toMs(ev.occurredAt) ?? toMs(ev.createdAt);
          const label =
            view?.base != null
              ? relLabel(ms, view.base)
              : (typeof ev.occurredAt === "string" && ev.occurredAt.startsWith("T+"))
                ? ev.occurredAt
                : "";

          return (
            <div key={String(ev.id || i)} style={frame()}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontWeight: 950 }}>{ev.title || ev.type || ev.id}</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>{label}</div>
              </div>
              {ev.message && (
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  {ev.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
        Read-only preview. Timeline becomes “real” once we wire generation + incident reads.
      </div>
    </details>
  );
}
