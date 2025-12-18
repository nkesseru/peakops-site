"use client";

import { useEffect, useMemo, useState } from "react";

export default function UsagePage() {
  const [orgId, setOrgId] = useState("org_001");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    const r = await fetch(`/api/fn/listUsageEvents?orgId=${encodeURIComponent(orgId)}`);
    const j = await r.json();
    if (!j.ok) { setErr(j.error || "listUsageEvents failed"); setData(null); return; }
    setData(j);
  }

  useEffect(() => { load(); }, []);

  const totals = data?.totals ?? null;
  const events = useMemo(() => data?.events ?? [], [data]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Admin · Usage</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
        <label>Org:</label>
        <input value={orgId} onChange={(e) => setOrgId(e.target.value)} style={{ padding: 8, border: "1px solid #ccc", borderRadius: 8 }} />
        <button onClick={load} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>Refresh</button>
      </div>

      {err && <pre style={{ marginTop: 12, color: "crimson" }}>{err}</pre>}

      {totals && (
        <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>Filings runs: <b>{totals.filings}</b></div>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>Timeline runs: <b>{totals.timeline}</b></div>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>Both runs: <b>{totals.both}</b></div>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>Changed: <b>{totals.changed}</b></div>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>Skipped: <b>{totals.skipped}</b></div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800 }}>Events (latest 200)</h2>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(events, null, 2)}</pre>
      </div>
    </div>
  );
}
