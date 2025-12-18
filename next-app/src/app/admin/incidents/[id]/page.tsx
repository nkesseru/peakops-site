"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

export default function AdminIncidentDetail() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();

  const incidentId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [bundle, setBundle] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resp, setResp] = useState<any>(null);

  async function load() {
    setErr(null);
    const r = await fetch(`/api/fn/getIncidentBundle?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const j = await r.json();
    if (!j.ok) {
      setBundle(null);
      setErr(j.error || "getIncidentBundle failed");
      return;
    }
    setBundle(j);
  }

  useEffect(() => { if (incidentId) load(); }, [incidentId]);

  async function postFn(path: string, body: any) {
    const r = await fetch(`/api/fn/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function generateFullFilingsAndTimeline() {
    setBusy("PeakOps");
    setResp(null);
    setErr(null);
    try {
      const a = await postFn("generateFilingPackageFromIncident", { incidentId, orgId });
      if (!a.ok) throw new Error(a.error || "generateFilingPackageFromIncident failed");

      const b = await postFn("generateTimelineAndPersist", { incidentId, orgId });
      if (!b.ok) throw new Error(b.error || "generateTimelineAndPersist failed");

      setResp({ filings: a, timeline: b });
      await load();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

async function generateFilingsOnly() {
  setBusy("filings");
  setResp(null);
  setErr(null);
  try {
    const a = await postFn("generateFilingPackageFromIncident", { incidentId, orgId });
    if (!a.ok) throw new Error(a.error || "generateFilingPackageFromIncident failed");
    setResp(a);
    await load();
  } catch (e: any) {
    setErr(e.message || String(e));
  } finally {
    setBusy(null);
  }
}

async function generateTimelineOnly() {
  setBusy("timeline");
  setResp(null);
  setErr(null);
  try {
    const b = await postFn("generateTimelineAndPersist", { incidentId, orgId });
    if (!b.ok) throw new Error(b.error || "generateTimelineAndPersist failed");
    setResp(b);
    await load();
  } catch (e: any) {
    setErr(e.message || String(e));
  } finally {
    setBusy(null);
  }
}

  const incident = bundle?.incident ?? null;
  const filings = bundle?.filings ?? [];
  const timelineMeta = bundle?.timelineMeta ?? null;
  const logs = bundle?.logs ?? null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Admin · Incident {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button onClick={load} disabled={!!busy} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          Refresh
        </button>

        <button onClick={generateFullFilingsAndTimeline} disabled={!!busy} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy === "ultimate" ? "Autopilot..." : "Ultimate: Full Filings + Timeline"}
        </button>
      </div>


	<button onClick={generateTimelineOnly} disabled={!!busy} ...>
  	{busy === "timeline" ? "Working..." : "Generate Timeline"}
	</button>

	<button onClick={generateFilingsAndTimeline} disabled={!!busy} ...>
  	{busy === "both" ? "Working..." : "Generate Both"}
	</button>

      {err && <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}
      {resp && <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 12, borderRadius: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(resp, null, 2)}</pre>}

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
