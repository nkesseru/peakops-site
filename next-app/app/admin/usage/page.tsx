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
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid #1a1a1a",
    background: "#111",
    color: "#ccc",
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
    if (!j.ok) {
      const msg = j.error || "listUsageEvents failed";
      setErr(
        msg.includes("does not exist")
          ? "This module requires backend services that are not deployed in this environment."
          : msg,
      );
      setData(null);
      return;
    }
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
    border: "1px solid #1a1a1a",
    borderRadius: 8,
    padding: 16,
    background: "#0a0a0a",
  };

  const btnS: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #1a1a1a",
    background: "#0a0a0a",
    color: "#ccc",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };

  const input: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #1a1a1a",
    background: "#050505",
    color: "#ddd",
    fontSize: 13,
  };

  return (
    <div style={{ padding: "28px 24px", fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: "#fff", minHeight: "calc(100vh - 44px)", background: "#000" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Usage</h1>

      <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#666" }}>Org</span>
        <input value={orgId} onChange={(e) => setOrgId(e.target.value)} style={input} />
        <button onClick={load} style={btnS}>Refresh</button>

        <span style={{ fontSize: 12, color: "#666", marginLeft: 4 }}>Filter</span>
        <select value={action} onChange={(e) => setAction(e.target.value as Action)} style={input}>
          <option value="all">All</option>
          <option value="filings">Filings</option>
          <option value="timeline">Timeline</option>
          <option value="both">Both</option>
        </select>
      </div>

      {err && (
        <div style={{ marginTop: 16, padding: "20px 24px", borderRadius: 8, border: "1px solid #1a1a1a", background: "#0a0a0a", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "#777", lineHeight: 1.6 }}>{err}</div>
        </div>
      )}

      {totals && (
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
          <div style={card}><div style={{ fontSize: 11, color: "#666" }}>Filings runs</div><div style={{ fontWeight: 700, fontSize: 20, color: "#fff", marginTop: 4 }}>{totals.filings}</div></div>
          <div style={card}><div style={{ fontSize: 11, color: "#666" }}>Timeline runs</div><div style={{ fontWeight: 700, fontSize: 20, color: "#fff", marginTop: 4 }}>{totals.timeline}</div></div>
          <div style={card}><div style={{ fontSize: 11, color: "#666" }}>Both runs</div><div style={{ fontWeight: 700, fontSize: 20, color: "#fff", marginTop: 4 }}>{totals.both}</div></div>
          <div style={card}><div style={{ fontSize: 11, color: "#666" }}>Changed</div><div style={{ fontWeight: 700, fontSize: 20, color: "#fff", marginTop: 4 }}>{derived.changed}</div></div>
          <div style={card}><div style={{ fontSize: 11, color: "#666" }}>Skipped</div><div style={{ fontWeight: 700, fontSize: 20, color: "#fff", marginTop: 4 }}>{derived.skipped}</div></div>
        </div>
      )}

      <div style={{ marginTop: 16, ...card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#fff" }}>Usage Events</h2>
          <span style={{ fontSize: 11, color: "#555" }}>Latest {events.length} (max 200)</span>
        </div>

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #1a1a1a" }}>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>When</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Action</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Incident</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Changed</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Skipped</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "10px 8px", color: "#666", fontWeight: 600 }}>Usage ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e: any) => (
                <tr key={e.id} style={{ borderBottom: "1px solid #111" }}>
                  <td style={{ padding: "10px 8px", whiteSpace: "nowrap", color: "#aaa" }}>{fmtTs(e.createdAt)}</td>
                  <td style={{ padding: "10px 8px" }}>
                    <span style={pill(e.action)}>{e.action || "—"}</span>
                  </td>
                  <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                    <a
                      href={`/admin/incidents/${encodeURIComponent(e.incidentId || "")}?orgId=${encodeURIComponent(orgId)}`}
                      style={{ color: "#C8A84E", textDecoration: "none" }}
                    >
                      {e.incidentId || "—"}
                    </a>
                  </td>
                  <td style={{ padding: "10px 8px", color: "#ccc" }}>{Number(e.changedCount || 0)}</td>
                  <td style={{ padding: "10px 8px", color: "#ccc" }}>{Number(e.skippedCount || 0)}</td>
                  <td style={{ padding: "10px 8px", color: "#888" }}>{e.status || "—"}</td>
                  <td style={{ padding: "10px 8px", color: "#555", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{e.id}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "16px 8px", color: "#555", fontSize: 12 }}>No events yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
