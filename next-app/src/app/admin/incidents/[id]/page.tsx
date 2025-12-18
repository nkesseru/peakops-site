"use client";

import { useEffect, useState } from "react";

export default function IncidentDetail({ params, searchParams }: any) {
  const incidentId = params.id as string;
  const orgId = (searchParams?.orgId as string) || "org_001";

  const [incident, setIncident] = useState<any>(null);
  const [logs, setLogs] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resp, setResp] = useState<any>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const a = await fetch(`/api/fn/getIncident?incidentId=${encodeURIComponent(incidentId)}`);
      const aj = await a.json();
      if (!aj.ok) throw new Error(aj.error || "getIncident failed");
      setIncident(aj.incident);

      const b = await fetch(
        `/api/fn/getIncidentLogs?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
      );
      const bj = await b.json();
      if (!bj.ok) throw new Error(bj.error || "getIncidentLogs failed");
      setLogs(bj);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function postFn(path: string, body: any) {
    const r = await fetch(`/api/fn/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function persistDirsStub() {
    setBusy("filings");
    setResp(null);
    setErr(null);
    try {
      const out = await postFn("generateFilingPackageAndPersist", {
        incidentId,
        orgId,
        title: incident?.title ?? "",
        startTime: incident?.startTime ?? new Date().toISOString(),
        draftsByType: {
          DIRS: {
            payload: { filingType: "DIRS", incidentId, orgId },
            generatedAt: new Date().toISOString(),
          },
        },
        compliance: null,
        generatorVersion: "v1",
      });
      if (!out.ok) throw new Error(out.error || "generateFilingPackageAndPersist failed");
      setResp(out);
      await load();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function generateTimeline() {
    setBusy("timeline");
    setResp(null);
    setErr(null);
    try {
      const out = await postFn("generateTimelineAndPersist", { incidentId, orgId });
      if (!out.ok) throw new Error(out.error || "generateTimelineAndPersist failed");
      setResp(out);
      await load();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Incident · {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button onClick={load} disabled={loading || !!busy} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {loading ? "Loading..." : "Refresh"}
        </button>

        <button onClick={persistDirsStub} disabled={loading || !!busy} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy === "filings" ? "Working..." : "Persist DIRS draft (stub)"}
        </button>

        <button onClick={generateTimeline} disabled={loading || !!busy} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc" }}>
          {busy === "timeline" ? "Working..." : "Generate timeline"}
        </button>
      </div>

      {err && <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}

      {resp && (
        <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 12, borderRadius: 12, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(resp, null, 2)}
        </pre>
      )}

      <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Incident</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{incident ? JSON.stringify(incident, null, 2) : "—"}</pre>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, marginBottom: 10 }}>Logs</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{logs ? JSON.stringify(logs, null, 2) : "—"}</pre>
        </section>
      </div>
    </div>
  );
}
