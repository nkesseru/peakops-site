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
async function copyText(txt: string) { try { await navigator.clipboard.writeText(txt); } catch {} }

function statusPill(status?: string) {
  const v = String(status || "DRAFT").toUpperCase();
  const base: any = {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
  };
  if (v === "READY") return { ...base, background: "color-mix(in oklab, lime 18%, transparent)" };
  if (v === "SUBMITTED") return { ...base, background: "color-mix(in oklab, deepskyblue 16%, transparent)" };
  if (v === "AMENDED") return { ...base, background: "color-mix(in oklab, orange 18%, transparent)" };
  if (v === "CANCELLED") return { ...base, background: "color-mix(in oklab, red 14%, transparent)" };
  return base;
}

function PanelCard({ title, children }: any) {
  const card: React.CSSProperties = {
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, Canvas 92%, CanvasText 2%)",
  };
  return (
    <section style={card}>
      <h2 style={{ fontSize: 14, fontWeight: 900, margin: 0, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}

function Button({ children, onClick, disabled }: any) {
  const btn: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
  return <button style={btn} disabled={disabled} onClick={onClick}>{children}</button>;
}

function FilingActionsPanel({ logs }: any) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("ALL");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const items = useMemo(() => {
    const arr: any[] = [];
    if (logs?.filing) for (const x of logs.filing) arr.push(x);
    return arr.sort((a,b) => String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  }, [logs]);

  const filingTypes = useMemo(() => {
    const set = new Set<string>();
    for (const x of items) if (x.filingType) set.add(String(x.filingType));
    return ["ALL", ...Array.from(set).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items.filter(x => {
      if (type !== "ALL" && String(x.filingType) !== type) return false;
      if (!t) return true;
      return (
        String(x.filingType||"").toLowerCase().includes(t) ||
        String(x.action||"").toLowerCase().includes(t) ||
        String(x.message||"").toLowerCase().includes(t) ||
        String(x.from||"").toLowerCase().includes(t) ||
        String(x.to||"").toLowerCase().includes(t)
      );
    });
  }, [items, q, type]);

  const inputStyle: React.CSSProperties = {
    padding: 10,
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "Canvas",
    color: "CanvasText",
  };

  return (
    <div>
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
        <input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search filing actions…" style={{ ...inputStyle, flex: 1, minWidth: 240 }} />
        <select value={type} onChange={(e)=>setType(e.target.value)} style={inputStyle}>
          {filingTypes.map(ft => <option key={ft} value={ft}>{ft}</option>)}
        </select>
        <div style={{ fontSize:12, opacity:0.7 }}>{filtered.length} shown</div>
      </div>

      <div style={{ display:"grid", gap:8 }}>
        {filtered.map((x:any) => {
          const id = x.id || Math.random().toString(36).slice(2);
          const isOpen = !!open[id];
          return (
            <div key={id} style={{
              border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
              borderRadius: 12,
              padding: 10,
              background: "color-mix(in oklab, CanvasText 3%, transparent)"
            }}>
              <div style={{ display:"flex", justifyContent:"space-between", gap:12 }}>
                <div>
                  <div style={{ fontSize:12, opacity:0.7 }}>
                    {fmtTs(x.createdAt)} · {x.filingType || "—"} · {x.action || "—"}
                  </div>
                  <div style={{ fontWeight:900 }}>
                    {x.from ? `${x.from} → ${x.to}` : (x.to ? String(x.to) : "Action")}
                  </div>
                  <div style={{ opacity:0.9 }}>{x.message || ""}</div>
                </div>

                <button
                  style={{
                    padding:"6px 10px",
                    borderRadius: 10,
                    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
                    background:"transparent",
                    color:"CanvasText",
                    cursor:"pointer",
                    height: 34,
                    alignSelf:"center"
                  }}
                  onClick={()=>setOpen(o=>({ ...o, [id]: !o[id] }))}
                >
                  {isOpen ? "Hide" : "Show"}
                </button>
              </div>

              {isOpen && (
                <pre style={{ marginTop:10, whiteSpace:"pre-wrap", fontSize:12, opacity:0.9 }}>
{JSON.stringify(x, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ opacity:0.7 }}>No filing actions yet.</div>}
      </div>
    </div>
  );
}

function SystemUserLogsPanel({ logs }: any) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const items = useMemo(() => {
    const all: any[] = [];
    if (logs?.system) for (const x of logs.system) all.push({ bucket: "system", ...x });
    if (logs?.user) for (const x of logs.user) all.push({ bucket: "user", ...x });
    return all.sort((a,b) => String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  }, [logs]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter(x =>
      String(x.event||"").toLowerCase().includes(t) ||
      String(x.message||"").toLowerCase().includes(t) ||
      String(x.bucket||"").toLowerCase().includes(t)
    );
  }, [items, q]);

  const inputStyle: React.CSSProperties = {
    padding: 10,
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "Canvas",
    color: "CanvasText",
  };

  return (
    <div>
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10 }}>
        <input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search system/user logs…" style={{ ...inputStyle, flex: 1 }} />
        <div style={{ fontSize:12, opacity:0.7 }}>{filtered.length} shown</div>
      </div>

      <div style={{ display:"grid", gap:8 }}>
        {filtered.map((x:any) => {
          const id = x.id || Math.random().toString(36).slice(2);
          const isOpen = !!open[id];
          return (
            <div key={id} style={{
              border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
              borderRadius: 12,
              padding: 10,
              background: "color-mix(in oklab, CanvasText 3%, transparent)"
            }}>
              <div style={{ display:"flex", justifyContent:"space-between", gap:12 }}>
                <div>
                  <div style={{ fontSize:12, opacity:0.7 }}>{fmtTs(x.createdAt)} · {x.bucket}</div>
                  <div style={{ fontWeight:900 }}>{x.event || "—"}</div>
                  <div style={{ opacity:0.9 }}>{x.message || ""}</div>
                </div>
                <button
                  style={{
                    padding:"6px 10px",
                    borderRadius: 10,
                    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
                    background:"transparent",
                    color:"CanvasText",
                    cursor:"pointer",
                    height: 34,
                    alignSelf:"center"
                  }}
                  onClick={()=>setOpen(o=>({ ...o, [id]: !o[id] }))}
                >
                  {isOpen ? "Hide" : "Show"}
                </button>
              </div>

              {isOpen && (
                <pre style={{ marginTop:10, whiteSpace:"pre-wrap", fontSize:12, opacity:0.9 }}>
{JSON.stringify(x.context || x, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ opacity:0.7 }}>No system/user logs yet.</div>}
      </div>
    </div>
  );
}

export default function SupervisorIncidentDetail() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const incidentId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [bundle, setBundle] = useState<any>(null);
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  async function jfetch(url: string) {
    const r = await fetch(url);
    return r.json();
  }

  async function loadBundle() {
    setErr(null);
    for (let i = 0; i < 4; i++) {
      const j = await jfetch(`/api/fn/getIncidentBundle?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      if (j.ok) { setBundle(j); return; }
      await new Promise(r => setTimeout(r, 250));
    }
    setBundle(null);
    setErr("getIncidentBundle failed");
  }

  async function loadTimeline() {
    const j = await jfetch(`/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    if (j.ok) setTimelineEvents(j.events || []);
  }

  useEffect(() => {
    if (!incidentId) return;
    loadBundle(); loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  async function postFn(path: string, body: any) {
    const r = await fetch(`/api/fn/${path}`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function runFilings() {
    setBusy("filings"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateFilingsV2", { incidentId, orgId, requestedBy: "supervisor_ui" });
      if (!out.ok) throw new Error(out.error || "generateFilingsV2 failed");
      const updated = (out.changed || []).length;
      const unchanged = (out.skipped || []).length;
      setBanner(updated === 0 ? `Filings unchanged (${unchanged}) · No changes — no charge` : `Filings updated ${updated} · unchanged ${unchanged}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runTimelineGen() {
    setBusy("timeline"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateTimelineV2", { incidentId, orgId, requestedBy: "supervisor_ui" });
      if (!out.ok) throw new Error(out.error || "generateTimelineV2 failed");
      setBanner(out.skipped ? `Timeline unchanged · No changes — no charge` : `Timeline generated ${out.eventCount} events`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runBoth() {
    setBusy("both"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateBothV2", { incidentId, orgId, requestedBy: "supervisor_ui" });
      if (!out.ok) throw new Error(out.error || "generateBothV2 failed");
      const f = out.filings || {};
      const t = out.timeline || {};
      const fu = (f.changed || []).length;
      const fs = (f.skipped || []).length;
      const fMsg = fu === 0 ? `Filings unchanged (${fs}) · No changes — no charge` : `Filings updated ${fu} · unchanged ${fs}`;
      const tMsg = t.skipped ? `Timeline unchanged · No changes — no charge` : `Timeline ${t.eventCount} events`;
      setBanner(`${fMsg} · ${tMsg}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  const incident = bundle?.incident ?? null;
  const filings = useMemo(() => (bundle?.filings ?? []), [bundle]);
  const logs = bundle?.logs ?? null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Supervisor · Incident {incidentId}</h1>
        <a href={`/supervisor/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.8 }}>← Back</a>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <Button disabled={!!busy} onClick={() => { loadBundle(); loadTimeline(); }}>Refresh</Button>
        <Button disabled={!!busy} onClick={runFilings}>{busy==="filings" ? "Working…" : "Generate Filings"}</Button>
        <Button disabled={!!busy} onClick={runTimelineGen}>{busy==="timeline" ? "Working…" : "Generate Timeline"}</Button>
        <Button disabled={!!busy} onClick={runBoth}>{busy==="both" ? "Working…" : "Generate Both"}</Button>
      </div>

      {banner && (
        <div style={{
          marginTop: 10,
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
          background: "color-mix(in oklab, CanvasText 4%, transparent)",
          fontWeight: 800
        }}>{banner}</div>
      )}
      {err && <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}

      <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
        <PanelCard title="Timeline">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {timelineEvents.map((e:any) => (
              <li key={e.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize:12, opacity:0.7 }}>{fmtTs(e.occurredAt)} · {e.type}</div>
                <div style={{ fontWeight:800 }}>{e.title || ""}</div>
                <div style={{ opacity:0.9 }}>{e.message || ""}</div>
              </li>
            ))}
            {timelineEvents.length === 0 && <li style={{ opacity:0.7 }}>No timeline events yet.</li>}
          </ul>
        </PanelCard>

        <PanelCard title="Filings">
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ textAlign:"left", borderBottom:"1px solid color-mix(in oklab, CanvasText 18%, transparent)" }}>
                  <th style={{ padding:"10px 8px" }}>Type</th>
                  <th style={{ padding:"10px 8px" }}>Status</th>
                  <th style={{ padding:"10px 8px" }}>Payload Hash</th>
                  <th style={{ padding:"10px 8px" }}>Generated</th>
                  <th style={{ padding:"10px 8px" }}>Copy</th>
                </tr>
              </thead>
              <tbody>
                {filings.map((f:any) => {
                  const st = String(f.status || "DRAFT").toUpperCase();
                  return (
                    <tr key={f.id} style={{ borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
                      <td style={{ padding:"10px 8px", fontWeight:900 }}>{f.type || f.id}</td>
                      <td style={{ padding:"10px 8px" }}><span style={statusPill(st)}>{st}</span></td>
                      <td style={{ padding:"10px 8px", fontFamily:"ui-monospace, Menlo, monospace", opacity:0.85 }}>{shortHash(f?.payloadHash?.value)}</td>
                      <td style={{ padding:"10px 8px", opacity:0.85 }}>{fmtTs(f.generatedAt)}</td>
                      <td style={{ padding:"10px 8px" }}>
                        <Button disabled={!f?.payloadHash?.value} onClick={() => copyText(String(f?.payloadHash?.value || ""))}>Copy hash</Button>
                      </td>
                    </tr>
                  );
                })}
                {filings.length === 0 && (
                  <tr><td colSpan={5} style={{ padding:12, opacity:0.7 }}>No filings yet. Click “Generate Filings”.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </PanelCard>

        <PanelCard title="Filing Actions">
          <FilingActionsPanel logs={logs} />
        </PanelCard>

        <PanelCard title="System & User Logs">
          <SystemUserLogsPanel logs={logs} />
        </PanelCard>

        <PanelCard title="Incident">
          <pre style={{ margin:0, whiteSpace:"pre-wrap" }}>{incident ? JSON.stringify(incident, null, 2) : "—"}</pre>
        </PanelCard>
      </div>
    </div>
  );
}
