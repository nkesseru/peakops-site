"use client";

import { useEffect, useMemo, useState } from "react";

type Action = "all" | "filings" | "timeline" | "both";

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function pill(action: string) {
  const base: React.CSSProperties = {
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
  };
  return base;
}

export default function UsagePage() {
  const [orgId, setOrgId] = useState("org_001");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("all");

  async function load() {
    setErr(null);
    const r = await fetch(`/api/fn/listUsageEvents?orgId=${encodeURIComponent(orgId)}`);
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "listUsageEvents failed"); setData(null); return; }
    setData(j);
  }

  useEffect(() => { load(); }, []);

  const totals = data?.totals ?? null;
  const rawEvents = data?.events ?? [];

  const events = useMemo(() => {
    if (action === "all") return rawEvents;
    return rawEvents.filter((e: any) => e.action === action);
  }, [rawEvents, action]);

  const derived = useMemo(() => {
    let changed = 0, skipped = 0;
    for (const e of events) {
      changed += Number(e.changedCount || 0);
      skipped += Number(e.skippedCount || 0);
    }
    return { changed, skipped };
  }, [events]);

  const card: React.CSSProperties = {
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, Canvas 92%, CanvasText 2%)",
  };

  const btn: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    cursor: "pointer",
  };

  const input: React.CSSProperties = {
    padding: 10,
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "Canvas",
    color: "CanvasText",
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Admin · Usage</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.8 }}>
          ← Back to incidents
        </a>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ opacity: 0.8 }}>Org</label>
        <input value={orgId} onChange={(e) => setOrgId(e.target.value)} style={input} />
        <button onClick={load} style={btn}>Refresh</button>

        <div style={{ marginLeft: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ opacity: 0.8 }}>Filter</label>
          <select value={action} onChange={(e) => setAction(e.target.value as Action)} style={input}>
            <option value="all">All</option>
            <option value="filings">Filings</option>
            <option value="timeline">Timeline</option>
            <option value="both">Both</option>
          </select>
        </div>
      </div>

      {err && (
        <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}

      {totals && (
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          <div style={card}><div style={{ opacity: 0.7, fontSize: 12 }}>Filings runs</div><div style={{ fontWeight: 900, fontSize: 22 }}>{totals.filings}</div></div>
          <div style={card}><div style={{ opacity: 0.7, fontSize: 12 }}>Timeline runs</div><div style={{ fontWeight: 900, fontSize: 22 }}>{totals.timeline}</div></div>
          <div style={card}><div style={{ opacity: 0.7, fontSize: 12 }}>Both runs</div><div style={{ fontWeight: 900, fontSize: 22 }}>{totals.both}</div></div>
          <div style={card}><div style={{ opacity: 0.7, fontSize: 12 }}>Changed (filtered)</div><div style={{ fontWeight: 900, fontSize: 22 }}>{derived.changed}</div></div>
          <div style={card}><div style={{ opacity: 0.7, fontSize: 12 }}>Skipped (filtered)</div><div style={{ fontWeight: 900, fontSize: 22 }}>{derived.skipped}</div></div>
        </div>
      )}

      <div style={{ marginTop: 16, ...card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0 }}>Usage Events</h2>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Latest {events.length} (max 200)</div>
        </div>

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid color-mix(in oklab, CanvasText 18%, transparent)" }}>
                <th style={{ padding: "10px 8px" }}>When</th>
                <th style={{ padding: "10px 8px" }}>Action</th>
                <th style={{ padding: "10px 8px" }}>Incident</th>
                <th style={{ padding: "10px 8px" }}>Changed</th>
                <th style={{ padding: "10px 8px" }}>Skipped</th>
                <th style={{ padding: "10px 8px" }}>Status</th>
                <th style={{ padding: "10px 8px" }}>Usage ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e: any) => (
                <tr key={e.id} style={{ borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
                  <td style={{ padding: "10px 8px", whiteSpace: "nowrap", opacity: 0.9 }}>{fmtTs(e.createdAt)}</td>
                  <td style={{ padding: "10px 8px" }}>
                    <span style={pill(e.action)}>{e.action || "—"}</span>
                  </td>
                  <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                    <a
                      href={`/admin/incidents/${encodeURIComponent(e.incidentId || "")}?orgId=${encodeURIComponent(orgId)}`}
                      style={{ color: "CanvasText" }}
                    >
                      {e.incidentId || "—"}
                    </a>
                  </td>
                  <td style={{ padding: "10px 8px" }}>{Number(e.changedCount || 0)}</td>
                  <td style={{ padding: "10px 8px" }}>{Number(e.skippedCount || 0)}</td>
                  <td style={{ padding: "10px 8px", opacity: 0.8 }}>{e.status || "—"}</td>
                  <td style={{ padding: "10px 8px", opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{e.id}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 12, opacity: 0.7 }}>No events yet. Click Generate Filings/Timeline/Both on an incident.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
