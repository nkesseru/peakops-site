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
  const [banner, setBanner] = useState<string | null>(null);

  async function load() {
    setErr(null);
    const res = await fetch(`/api/fn/getIncidentBundle?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const j = await res.json();
    if (!j.ok) {
      setBundle(null);
      setErr(j.error || "getIncidentBundle failed");
      return;
    }
    setBundle(j);
  }

  useEffect(() => { if (incidentId) { load(); loadTimeline(); } }, [incidentId]);

  async function postFn(path: string, body: any) {
    const r = await fetch(`/api/fn/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function runFilings() {
    setBusy("filings"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateFilingsV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateFilingsV2 failed");
      setBanner(`Filings: updated ${out.changed.length}, unchanged ${out.skipped.length}`);
      await load();
      await loadTimeline();
    } catch (e:any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runTimeline() {
    setBusy("timeline"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateTimelineV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateTimelineV2 failed");
      if (out.skipped) setBanner(`Timeline: unchanged (hash match). No update needed.`);
      else setBanner(`Timeline: generated ${out.eventCount} events`);
      await load();
    } catch (e:any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runBoth() {
    setBusy("both"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateBothV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateBothV2 failed");
      const f = out.filings;
      const t = out.timeline;
      const fMsg = `Filings: updated ${(f.changed||[]).length}, unchanged ${(f.skipped||[]).length}`;
      const tMsg = t.skipped ? `Timeline: unchanged` : `Timeline: ${t.eventCount} events`;
      setBanner(`${fMsg} · ${tMsg}`);
      await load();
    } catch (e:any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const incident = bundle?.incident ?? null;
  const filings = bundle?.filings ?? [];
  const timelineMeta = bundle?.timelineMeta ?? null;
  const logs = bundle?.logs ?? null;

  const filingsMeta = incident?.filingsMeta ?? null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Admin · Incident {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button disabled={!!busy} onClick={load}>Refresh</button>
        <button disabled={!!busy} onClick={runFilings}>{busy==="filings" ? "Working…" : "Generate Filings"}</button>
        <button disabled={!!busy} onClick={runTimeline}>{busy==="timeline" ? "Working…" : "Generate Timeline"}</button>
        <button disabled={!!busy} onClick={runBoth}>{busy==="both" ? "Working…" : "Generate Both"}</button>
      </div>

      {(filingsMeta || timelineMeta) && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
          {filingsMeta && <div>Filings last run: {filingsMeta.generatedAt} · updated {filingsMeta.changedCount} · unchanged {filingsMeta.skippedCount}</div>}
          {timelineMeta && <div>Timeline last run: {timelineMeta.generatedAt} · events {timelineMeta.eventCount} · hash {timelineMeta.timelineHash?.slice?.(0, 12)}…</div>}
        </div>
      )}

      {banner && <div style={{ marginTop: 10, padding: 10, border: "1px solid #ddd", borderRadius: 10 }}>{banner}</div>}
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
