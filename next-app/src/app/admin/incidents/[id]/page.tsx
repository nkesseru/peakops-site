"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

export default function IncidentDetailBundle() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();

  const incidentId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [bundle, setBundle] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setErr(null);
    const res = await fetch(`/api/fn/getIncidentBundle?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "getIncidentBundle failed");
    setBundle(j);
  }

  useEffect(() => { if (incidentId) load().catch(e => setErr(e.message)); }, [incidentId]);

  async function postFn(path: string, body: any) {
    const r = await fetch(`/api/fn/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `${path} failed`);
    return j;
  }

  async function generateTimeline() {
    setBusy("timeline"); setErr(null);
    try {
      await postFn("generateTimelineAndPersist", { incidentId, orgId });
      await load();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function generateFilingsFull() {
    setBusy("filings");
    setResp(null);
    setErr(null);
    try {
      const out = await postFn("generateFilingPackageFromIncident", { incidentId, orgId });
      if (!out.ok) throw new Error(out.error || "generateFilingPackageFromIncident failed");
      setResp(out);
      await load();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const incident = bundle?.incident;
  const filings = bundle?.filings ?? [];
  const timelineMeta = bundle?.timelineMeta ?? incident?.timelineMeta ?? null;
  const logs = bundle?.logs ?? null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Incident · {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button onClick={() => load().catch(e => setErr(e.message))} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          Refresh
        </button>
        <button disabled={!!busy} onClick={generateFilingsFull} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy === "filings" ? "Working..." : "Generate full filings"}
        </button>
        <button disabled={!!busy} onClick={generateTimeline} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy === "timeline" ? "Working..." : "Generate timeline"}
        </button>
      </div>

      {err && <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}

      <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Incident</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{incident ? JSON.stringify(incident, null, 2) : "—"}</pre>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Filings</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(filings, null, 2)}</pre>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Timeline Meta</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{timelineMeta ? JSON.stringify(timelineMeta, null, 2) : "—"}</pre>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Logs</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{logs ? JSON.stringify(logs, null, 2) : "—"}</pre>
        </section>
      </div>
    </div>
  );
}
