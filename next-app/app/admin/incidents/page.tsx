"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
// PEAKOPS_SLICE14_AUTHED_FETCH_MIGRATE_V1 (2026-05-06)
import { authedFetch } from "@/../lib/apiClient";

export default function AdminIncidentsPage() {
  const [orgId, setOrgId] = useState("org_001");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    try {
      const res = await authedFetch(`/api/fn/listIncidentsV1?orgId=${encodeURIComponent(orgId)}`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "listIncidentsV1 failed");
      setData(j);
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(
        msg.includes("does not exist")
          ? "This module requires backend services that are not deployed in this environment."
          : msg,
      );
    }
  }

  useEffect(() => { refresh(); }, []);

  async function createTest() {
    setBusy(true);
    setErr(null);
    try {
      const incidentId = `inc_${Math.random().toString(36).slice(2, 8)}`;
      const res = await authedFetch(`/api/fn/createIncidentV1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentId,
          orgId,
          title: "Windstorm outage - South District",
          filingTypesRequired: ["DIRS","OE_417","NORS","SAR","BABA"],
          status: "ACTIVE",
        }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "createIncidentV1 failed");
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const incidents = useMemo(() => data?.incidents ?? [], [data]);

  const inputStyle: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #1a1a1a",
    background: "#050505",
    color: "#ddd",
    fontSize: 13,
  };
  const btnStyle: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #1a1a1a",
    background: "#0a0a0a",
    color: "#ccc",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };

  return (
    <div style={{ padding: "28px 24px", fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: "#fff", minHeight: "calc(100vh - 44px)", background: "#000" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: "#fff" }}>Incidents</h1>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#666" }}>Org</span>
        <input
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          style={inputStyle}
        />
        <button onClick={refresh} style={btnStyle}>Refresh</button>
        <button disabled={busy} onClick={createTest} style={{ ...btnStyle, background: "#C8A84E", color: "#000", border: "none" }}>
          {busy ? "Creating..." : "Create Incident"}
        </button>
      </div>

      {err && <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5", fontSize: 12 }}>{err}</div>}

      <div style={{ marginTop: 20, display: "grid", gap: 8 }}>
        {incidents.length === 0 ? (
          <div style={{ color: "#555", fontSize: 13 }}>No incidents yet.</div>
        ) : (
          incidents.map((it: any) => (
            <Link
              key={it.id}
              href={`/admin/incidents/${encodeURIComponent(it.id)}?orgId=${encodeURIComponent(orgId)}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "14px 16px",
                borderRadius: 8,
                border: "1px solid #1a1a1a",
                background: "#0a0a0a",
                textDecoration: "none",
                color: "#fff",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{it.title ?? it.id}</div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                  {it.id} · {it.status ?? "?"} · {it.updatedAt ?? "—"}
                </div>
              </div>
              <span style={{ fontSize: 12, color: "#C8A84E", fontWeight: 600 }}>View →</span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
