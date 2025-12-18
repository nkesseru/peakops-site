"use client";

import { useEffect, useState } from "react";

type Incident = {
  id: string;
  orgId: string;
  title: string;
  status?: string;
  updatedAt?: string;
  startTime?: string;
  timelineMeta?: any;
};

export default function IncidentsPage() {
  const [orgId, setOrgId] = useState("org_001");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/fn/listIncidents?orgId=${encodeURIComponent(orgId)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed");
      setIncidents(j.incidents || []);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Incidents</h1>

      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
        <label>Org:</label>
        <input value={orgId} onChange={(e) => setOrgId(e.target.value)} style={{ padding: 8, width: 240 }} />
        <button onClick={refresh} style={{ padding: "8px 12px" }}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {err && <p style={{ color: "crimson", marginTop: 12 }}>{err}</p>}

      <div style={{ marginTop: 18 }}>
        {incidents.length === 0 ? (
          <p>No incidents found.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>ID</th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>Title</th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>Status</th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>Updated</th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>Timeline</th>
                <th style={{ padding: 8, borderBottom: "1px solid #ddd" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((x) => (
                <tr key={x.id}>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{x.id}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    <a href={`/admin/incidents/${encodeURIComponent(x.id)}?orgId=${encodeURIComponent(orgId)}`}>
                      {x.title || "(untitled)"}
                    </a>
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{x.status || ""}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{x.updatedAt || ""}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {x.timelineMeta?.timelineHash ? "✅" : "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    <button
                      onClick={async () => {
                        await fetch("/api/fn/generateTimelineAndPersist", {
                          method: "POST",
                          body: JSON.stringify({ incidentId: x.id, orgId }),
                        });
                        refresh();
                      }}
                      style={{ padding: "6px 10px" }}
                    >
                      Generate Timeline
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
