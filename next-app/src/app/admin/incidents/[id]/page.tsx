"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function shortHash(h?: string) {
  if (!h) return "—";
  return h.length > 14 ? `${h.slice(0, 12)}…${h.slice(-4)}` : h;
}

async function copyText(txt: string) {
  try { await navigator.clipboard.writeText(txt); } catch {}
}

export default function AdminIncidentDetail() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();

  const incidentId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [bundle, setBundle] = useState<any>(null);
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

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

  async function loadBundle() {
    setErr(null);
    const res = await fetch(
      `/api/fn/getIncidentBundle?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
    );
    const j = await res.json();
    if (!j.ok) { setBundle(null); setErr(j.error || "getIncidentBundle failed"); return; }
    setBundle(j);
  }

  async function loadTimeline() {
    const res = await fetch(
      `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
    );
    const j = await res.json();
    if (j.ok) setTimelineEvents(j.events || []);
  }

  useEffect(() => {
    if (!incidentId) return;
    loadBundle();
    loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

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
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runTimeline() {
    setBusy("timeline"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateTimelineV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateTimelineV2 failed");
      setBanner(out.skipped ? "Timeline: unchanged (hash match)" : `Timeline: generated ${out.eventCount} events`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runBoth() {
    setBusy("both"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateBothV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateBothV2 failed");
      const f = out.filings;
      const t = out.timeline;
      const fMsg = `Filings: updated ${(f.changed||[]).length}, unchanged ${(f.skipped||[]).length}`;
      const tMsg = t.skipped ? "Timeline: unchanged" : `Timeline: ${t.eventCount} events`;
      setBanner(`${fMsg} · ${tMsg}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  const incident = bundle?.incident ?? null;
  const filings = useMemo(() => (bundle?.filings ?? []), [bundle]);
  const timelineMeta = bundle?.timelineMeta ?? null;
  const logs = bundle?.logs ?? null;

  const filingsMeta = incident?.filingsMeta ?? null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Admin · Incident {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.8 }}>
          ← Back
        </a>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button style={btn} disabled={!!busy} onClick={() => { loadBundle(); loadTimeline(); }}>Refresh</button>
        <button style={btn} disabled={!!busy} onClick={runFilings}>{busy==="filings" ? "Working…" : "Generate Filings"}</button>
        <button style={btn} disabled={!!busy} onClick={runTimeline}>{busy==="timeline" ? "Working…" : "Generate Timeline"}</button>
        <button style={btn} disabled={!!busy} onClick={runBoth}>{busy==="both" ? "Working…" : "Generate Both"}</button>
        <a style={{ ...btn, textDecoration: "none", color: "CanvasText", opacity: 0.9 }} href={`/admin/usage?orgId=${encodeURIComponent(orgId)}`}>
          Usage →
        </a>
      </div>

      {(filingsMeta || timelineMeta) && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
          {filingsMeta && <div>Filings last run: {filingsMeta.generatedAt} · updated {filingsMeta.changedCount} · unchanged {filingsMeta.skippedCount}</div>}
          {timelineMeta && <div>Timeline last run: {timelineMeta.generatedAt} · events {timelineMeta.eventCount} · hash {String(timelineMeta.timelineHash||"").slice(0, 12)}…</div>}
        </div>
      )}

      {banner && <div style={{ marginTop: 10, padding: 10, border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", borderRadius: 12 }}>{banner}</div>}
      {err && <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}

      <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0, marginBottom: 10 }}>Timeline</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {timelineEvents.map((e:any) => (
              <li key={e.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{fmtTs(e.occurredAt)} · {e.type}</div>
                <div style={{ fontWeight: 800 }}>{e.title || ""}</div>
                <div style={{ opacity: 0.9 }}>{e.message || ""}</div>
              </li>
            ))}
            {timelineEvents.length === 0 && <li style={{ opacity: 0.7 }}>No timeline events yet.</li>}
          </ul>
        </section>

        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0, marginBottom: 10 }}>Filings</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid color-mix(in oklab, CanvasText 18%, transparent)" }}>
                  <th style={{ padding: "10px 8px" }}>Type</th>
                  <th style={{ padding: "10px 8px" }}>Status</th>
                  <th style={{ padding: "10px 8px" }}>Payload Hash</th>
                  <th style={{ padding: "10px 8px" }}>Generated</th>
                  <th style={{ padding: "10px 8px" }}>Copy</th>
                </tr>
              </thead>
              <tbody>
                {filings.map((f: any) => (
                  <tr key={f.id} style={{ borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
                    <td style={{ padding: "10px 8px", fontWeight: 900 }}>{f.type || f.id}</td>
                    <td style={{ padding: "10px 8px", opacity: 0.9 }}>{f.status || "—"}</td>
                    <td style={{ padding: "10px 8px", fontFamily: "ui-monospace, Menlo, monospace", opacity: 0.85 }}>
                      {shortHash(f?.payloadHash?.value)}
                    </td>
                    <td style={{ padding: "10px 8px", opacity: 0.85 }}>{fmtTs(f.generatedAt)}</td>
                    <td style={{ padding: "10px 8px" }}>
                      <button
                        style={btn}
                        onClick={() => copyText(String(f?.payloadHash?.value || ""))}
                        disabled={!f?.payloadHash?.value}
                      >
                        Copy hash
                      </button>
                    </td>
                  </tr>
                ))}
                {filings.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 12, opacity: 0.7 }}>No filings yet. Click “Generate Filings”.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0, marginBottom: 10 }}>Incident</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{incident ? JSON.stringify(incident, null, 2) : "—"}</pre>
        </section>

        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0, marginBottom: 10 }}>Logs</h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{logs ? JSON.stringify(logs, null, 2) : "—"}</pre>
        </section>
      </div>
    </div>
  );
}
