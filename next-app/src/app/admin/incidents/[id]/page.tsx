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


async function setFilingStatusUI(opts: {
  orgId: string;
  incidentId: string;
  filingType: string;
  toStatus: string;
}) {
  const { orgId, incidentId, filingType, toStatus } = opts;

  let confirmationId = "";
  let submissionMethod = "MANUAL";

  if (toStatus === "SUBMITTED") {
    confirmationId = prompt("Confirmation ID (required):", "") || "";
    if (!confirmationId.trim()) throw new Error("confirmationId is required");
    submissionMethod = prompt("Submission method (MANUAL/API/UPLOAD):", "MANUAL") || "MANUAL";
  }

  const r = await fetch("/api/fn/setFilingStatusV1", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      orgId,
      incidentId,
      filingType,
      toStatus,
      confirmationId,
      submissionMethod,
      userId: "admin_ui",
      message: "",
    })
  });

  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "setFilingStatusV1 failed");
  return j;
}


function LogPanel({ logs }: any) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const items = useMemo(() => {
    const all: any[] = [];
    if (logs?.system) for (const x of logs.system) all.push({ bucket: "system", ...x });
    if (logs?.user) for (const x of logs.user) all.push({ bucket: "user", ...x });
    if (logs?.filing) for (const x of logs.filing) all.push({ bucket: "filing", ...x });
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

  return (
    <div>
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10 }}>
        <input
          value={q}
          onChange={(e)=>setQ(e.target.value)}
          placeholder="Search logs (event/message)…"
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "Canvas",
            color: "CanvasText"
          }}
        />
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
        {filtered.length === 0 && <div style={{ opacity:0.7 }}>No logs match that search.</div>}
      </div>
    </div>
  );
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
        {filtered.length === 0 && <div style={{ opacity:0.7 }}>No filing actions yet. Use READY/SUBMITTED to create them.</div>}
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
  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 4%, transparent)",
    fontSize: 13,
    fontWeight: 700,
  };

  async function jfetch(url: string) {
    const r = await fetch(url);
    return r.json();
  }

  // retry small (handles “functions not loaded yet” at startup)
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

  function noChargeIf(cond: boolean) {
    return cond ? " · No changes — no charge" : "";
  }

  async function runFilings() {
    setBusy("filings"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateFilingsV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateFilingsV2 failed");
      const updated = (out.changed || []).length;
      const unchanged = (out.skipped || []).length;
      setBanner(`Filings: updated ${updated}, unchanged ${unchanged}${noChargeIf(updated === 0)}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runTimelineGen() {
    setBusy("timeline"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateTimelineV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateTimelineV2 failed");
      if (out.skipped) setBanner(`Timeline: unchanged (hash match) · No changes — no charge`);
      else setBanner(`Timeline: generated ${out.eventCount} events`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runBoth() {
    setBusy("both"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateBothV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateBothV2 failed");
      const f = out.filings || {};
      const t = out.timeline || {};
      const fu = (f.changed || []).length;
      const fs = (f.skipped || []).length;
      const fMsg = `Filings: updated ${fu}, unchanged ${fs}${noChargeIf(fu === 0)}`;
      const tMsg = t.skipped ? `Timeline: unchanged · No changes — no charge` : `Timeline: ${t.eventCount} events`;
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
        <button style={btn} disabled={!!busy} onClick={runTimelineGen}>{busy==="timeline" ? "Working…" : "Generate Timeline"}</button>
        <button style={btn} disabled={!!busy} onClick={runBoth}>{busy==="both" ? "Working…" : "Generate Both"}</button>
        <a style={{ ...btn, textDecoration: "none", color: "CanvasText", opacity: 0.9 }} href={`/admin/usage?orgId=${encodeURIComponent(orgId)}`}>Usage →</a>
      </div>

      {(filingsMeta || timelineMeta) && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
          {filingsMeta && <div>Filings last run: {filingsMeta.generatedAt} · updated {filingsMeta.changedCount} · unchanged {filingsMeta.skippedCount}</div>}
          {timelineMeta && <div>Timeline last run: {timelineMeta.generatedAt} · events {timelineMeta.eventCount} · hash {String(timelineMeta.timelineHash||"").slice(0, 12)}…</div>}
        </div>
      )}

      {banner && <div style={{ marginTop: 10, ...pill }}>{banner}</div>}
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
                  <th style={{ padding: "10px 8px" }}>Workflow</th>
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
                      <button style={btn} onClick={() => copyText(String(f?.payloadHash?.value || ""))} disabled={!f?.payloadHash?.value}>Copy hash</button>
                    </td>
                    <td style={{ padding: "10px 8px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        style={btn}
                        disabled={!!busy}
                        onClick={async () => {
                          try {
                            setBanner(null);
                            await setFilingStatusUI({ orgId, incidentId, filingType: (f.type || f.id), toStatus: "READY" });
                            setBanner(`✅ ${f.type || f.id} marked READY`);
                            await loadBundle(); await loadTimeline();
                          } catch (e:any) {
                            setErr(e.message || String(e));
                          }
                        }}
                      >
                        READY
                      </button>

                      <button
                        style={btn}
                        disabled={!!busy}
                        onClick={async () => {
                          try {
                            setBanner(null);
                            await setFilingStatusUI({ orgId, incidentId, filingType: (f.type || f.id), toStatus: "SUBMITTED" });
                            setBanner(`📨 ${f.type || f.id} marked SUBMITTED`);
                            await loadBundle(); await loadTimeline();
                          } catch (e:any) {
                            setErr(e.message || String(e));
                          }
                        }}
                      >
                        SUBMITTED
                      </button>
                    </td>

                  </tr>
                ))}
                {filings.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 12, opacity: 0.7 }}>No filings yet. Click “Generate Filings”.</td></tr>
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

          <LogPanel logs={logs} />
        </section>
      </div>
    </div>
  );
}
