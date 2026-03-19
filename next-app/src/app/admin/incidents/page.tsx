"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

export default function AdminIncidentsPage() {
  const [orgId, setOrgId] = useState("org_001");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    const res = await fetch(`/api/fn/listIncidents?orgId=${encodeURIComponent(orgId)}`);
    const j = await res.json();
    setData(j);
  }

  useEffect(() => { refresh(); }, []);

  async function createTest() {
    setBusy(true);
    setErr(null);
    try {
      const incidentId = `inc_${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch(`/api/fn/createIncident`, {
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
      if (!j.ok) throw new Error(j.error || "createIncident failed");
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const incidents = useMemo(() => data?.incidents ?? [], [data]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Admin · Incidents</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
        <label>Org:</label>
        <input
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 8 }}
        />
        <button onClick={refresh} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          Refresh
        </button>
        <button disabled={busy} onClick={createTest} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy ? "Creating..." : "Create test incident"}
        </button>
      </div>

      {err && <pre style={{ marginTop: 12, color: "crimson" }}>{err}</pre>}

      <div style={{ marginTop: 18 }}>
        {incidents.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No incidents yet.</div>
        ) : (
          <ul style={{ display: "grid", gap: 10, padding: 0, listStyle: "none" }}>
            {incidents.map((it: any) => (
              <li key={it.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{it.title ?? it.id}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {it.id} · {it.status ?? "?"} · updatedAt: {it.updatedAt ?? "?"}
                    </div>
                  </div>
                  <Link
                    href={`/admin/incidents/${encodeURIComponent(it.id)}?orgId=${encodeURIComponent(orgId)}`}
                    style={{ alignSelf: "center", textDecoration: "none" }}
                  >
                    View →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
