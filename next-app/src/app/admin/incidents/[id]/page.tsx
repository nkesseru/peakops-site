"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function shortHash(h?: string) {
  if (!h) return "—";
  return h.length > 18 ? `${h.slice(0, 12)}…${h.slice(-4)}` : h;
}

function attentionLine(x: any) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  const lvl = String(x.level || x.severity || "WARN").toUpperCase();
  const msg = x.msg || x.message || x.text || x.code || JSON.stringify(x);
  return `${lvl}: ${msg}`;
}
async function copyText(txt: string) {
  try { await navigator.clipboard.writeText(txt); } catch {}

function renderAttentionItemLocal(x: any) {
  if (!x) return "—";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  // common shapes
  if (x.text) return String(x.text);
  if (x.message) return String(x.message);
  if (x.code && x.path) return ` ()`;
  if (x.code) return String(x.code);
  try { return JSON.stringify(x); } catch { return String(x); }
}
}

function statusPillStyle(status?: string) {
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
    whiteSpace: "nowrap",
  };
  return <button style={btn} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Modal({ open, title, children, onClose }: any) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 9999, padding: 16
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(680px, 100%)",
          borderRadius: 16,
          border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
          background: "Canvas",
          color: "CanvasText",
          padding: 16
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{title}</div>
          <button
            style={{ border: "none", background: "transparent", color: "CanvasText", cursor: "pointer", fontSize: 18 }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: any) {
  return (
    <div style={{ display:"flex", gap:12, alignItems:"baseline", flexWrap:"wrap" }}>
      <div style={{ fontSize:12, opacity:0.7, width:140 }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:800, opacity:0.9 }}>{value ?? "—"}</div>
    </div>
  );
}

function FilingsMetaCard({ filingsMeta }: any) {
  if (!filingsMeta) return <div style={{ opacity:0.75 }}>Not generated yet. Click <b>Generate Filings</b>.</div>;
  return (
    <div style={{ display:"grid", gap:6 }}>
      <MetaRow label="Generated" value={fmtTs(filingsMeta.generatedAt)} />
      <MetaRow label="Updated" value={filingsMeta.changedCount ?? "—"} />
      <MetaRow label="Unchanged" value={filingsMeta.skippedCount ?? "—"} />
      <MetaRow label="Requested By" value={filingsMeta.requestedBy ?? "—"} />
    </div>
  );
}

function TimelineMetaCard({ timelineMeta }: any) {
  if (!timelineMeta) return <div style={{ opacity:0.75 }}>Not generated yet. Click <b>Generate Timeline</b>.</div>;
  return (
    <div style={{ display:"grid", gap:6 }}>
      <MetaRow label="Generated" value={fmtTs(timelineMeta.generatedAt)} />
      <MetaRow label="Event Count" value={timelineMeta.eventCount ?? "—"} />
      <MetaRow label="Hash" value={shortHash(String(timelineMeta.timelineHash || ""))} />
      <MetaRow label="Source" value={timelineMeta.source ?? "system"} />
    </div>
  );
}


function computeExportBlockers({ incident, filings, timelineMeta, logs }: any) {
  const blockers: string[] = [];

  if (!incident?.id) blockers.push("Incident is missing or not loaded.");
  if (!timelineMeta?.timelineHash) blockers.push("Timeline has not been generated yet.");
  if (!Array.isArray(filings) || filings.length === 0) blockers.push("No filings generated yet. Click Generate Filings.");

  const required = Array.isArray(incident?.filingTypesRequired) ? incident.filingTypesRequired : [];
  if (required.length) {
    const byType = new Set((filings || []).map((f:any) => String(f.type || f.id)));
    for (const t of required) {
      if (!byType.has(String(t))) blockers.push(`Missing filing doc: ${t}`);
    }
  }

  // If a filing is SUBMITTED, ensure it has confirmationId
  for (const f of filings || []) {
    const st = String(f.status || "DRAFT").toUpperCase();
    if (st === "SUBMITTED") {
      const cid = f?.external?.confirmationId || f?.external?.mapValue?.fields?.confirmationId?.stringValue;
      if (!cid) blockers.push(`Filing ${f.type || f.id} is SUBMITTED but missing confirmationId`);
    }
  }

  // Guardrail: if any filing is READY, it's not "blocking" export, but it is safeAttention-worthy.
  // We'll treat READY as a warning in the safeAttention panel, not a hard blocker.
  return blockers;
}

function computeAttention({ incident, filings, timelineMeta }: any) {
  const items: { level: "BLOCK"|"WARN"; text: string }[] = [];

  const required = Array.isArray(incident?.filingTypesRequired) ? incident.filingTypesRequired : [];
  const byType = new Map((filings || []).map((f:any) => [String(f.type || f.id), f]));

  if (!timelineMeta?.timelineHash) items.push({ level:"BLOCK", text:"Timeline not generated yet." });

  if (!filings?.length) items.push({ level:"BLOCK", text:"No filings generated yet." });

  for (const t of required) {
    if (!byType.has(String(t))) items.push({ level:"BLOCK", text:`Missing filing: ${t}` });
  }

  for (const f of filings || []) {
    const t = String(f.type || f.id);
    const st = String(f.status || "DRAFT").toUpperCase();
    if (st === "DRAFT") items.push({ level:"WARN", text:`${t} is still DRAFT` });
    if (st === "READY") items.push({ level:"WARN", text:`${t} is READY but not submitted` });
    if (st === "SUBMITTED") {
      const cid = f?.external?.confirmationId;
      if (!cid) items.push({ level:"BLOCK", text:`${t} is SUBMITTED but missing confirmationId` });
    }
  }

  return items;
}

function IncidentSummaryCard({ incident }: any) {
  if (!incident) return <div style={{ opacity:0.7 }}>—</div>;
  const filings = Array.isArray(incident.filingTypesRequired) ? incident.filingTypesRequired : [];
  return (
    <div style={{ display:"grid", gap:8 }}>
      <div style={{ display:"flex", gap:10, alignItems:"baseline", flexWrap:"wrap" }}>
        <div style={{ fontSize:18, fontWeight:900 }}>{incident.title || incident.id}</div>
        <span style={statusPillStyle(incident.status)}>{String(incident.status || "DRAFT").toUpperCase()}</span>
      </div>

      <div style={{ display:"grid", gap:6 }}>
        <MetaRow label="Incident ID" value={<span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{incident.id}</span>} />
        <MetaRow label="Start" value={fmtTs(incident.startTime)} />
        <MetaRow label="Detected" value={fmtTs(incident.detectedTime)} />
        <MetaRow label="Resolved" value={fmtTs(incident.resolvedTime)} />
        <MetaRow
          label="Location"
          value={
            (incident.location?.city || "—") +
            (incident.location?.state ? `, ${incident.location.state}` : "") +
            (incident.location?.county ? ` (${incident.location.county})` : "")
          }
        />
        <MetaRow label="Affected Customers" value={incident.affectedCustomers ?? "—"} />

        <div style={{ display:"flex", gap:12, alignItems:"baseline", flexWrap:"wrap" }}>
          <div style={{ fontSize:12, opacity:0.7, width:140 }}>Required Filings</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {filings.length ? filings.map((t:string) => (
              <span key={t} style={{
                padding:"3px 10px", borderRadius:999, fontSize:12, fontWeight:800,
                border:"1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                background:"color-mix(in oklab, CanvasText 4%, transparent)"
              }}>{t}</span>
            )) : <span style={{ opacity:0.7 }}>—</span>}
          </div>
        </div>

        <MetaRow label="Updated" value={fmtTs(incident.updatedAt)} />
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

export default function AdminIncidentDetail() {
  
  // --- Local helper (keeps Turbopack from losing the symbol) ---
  const renderAttentionItemLocal = (x: any) => {
    try {
      if (!x) return "WARN: Unknown issue";
      if (typeof x === "string") return x;
      const lvl = String(x.level || x.severity || "WARN").toUpperCase();
      const msg = (x.message ?? x.text ?? x.reason ?? x.code ?? "");
      if (msg) return `${lvl}: ${msg}`;
      try { return `${lvl}: ${JSON.stringify(x)}`; } catch { return `${lvl}: ${String(x)}`; }
    } catch {
      return "WARN: Unknown issue";
    }
  };

const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const incidentId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [bundle, setBundle] = useState<any>(null);
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitType, setSubmitType] = useState<string>("");
  const [confirmationId, setConfirmationId] = useState("");
  const [method, setMethod] = useState("MANUAL");
  const [override, setOverride] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelType, setCancelType] = useState<string>("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelOverride, setCancelOverride] = useState(false);

  // export modal
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPurpose, setExportPurpose] = useState("REGULATORY");

  async function jfetch(url: string) {
    const r = await fetch(url);
    return r.json();
  }

  async function loadTimeline() {
    const j = await jfetch(`/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    if (j.ok) setTimelineEvents(j.events || []);
  }

async function loadRil() {
  return loadTimeline();
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

  useEffect(() => {
    if (!incidentId) return;
    loadBundle(); loadRil();
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
      const out = await postFn("generateFilingsV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateFilingsV2 failed");
      const updated = (out.changed || []).length;
      const unchanged = (out.skipped || []).length;
      setBanner(updated === 0 ? `Filings unchanged (${unchanged}) · No charge` : `Filings updated ${updated} · unchanged ${unchanged}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function runTimelineGen() {
    setBusy("timeline"); setErr(null); setBanner(null);
    try {
      const out = await postFn("generateTimelineV2", { incidentId, orgId, requestedBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "generateTimelineV2 failed");
      setBanner(out.skipped ? `Timeline unchanged · No charge` : `Timeline generated ${out.eventCount} events`);
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
      const fMsg = fu === 0 ? `Filings unchanged (${fs}) · No charge` : `Filings updated ${fu} · unchanged ${fs}`;
      const tMsg = t.skipped ? `Timeline unchanged · No charge` : `Timeline ${t.eventCount} events`;
      setBanner(`${fMsg} · ${tMsg}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function setStatus(toStatus: string, filingType: string, extra: any = {}) {
    setBusy("status"); setErr(null); setBanner(null);
    try {
      const out = await postFn("setFilingStatusV1", {
        orgId,
        incidentId,
        filingType,
        toStatus,
        userId: "admin_ui",
        message: "",
        ...extra,
      });
      if (!out.ok) throw new Error(out.error || "setFilingStatusV1 failed");
      setBanner(`✅ ${filingType} ${toStatus}`);
      await loadBundle(); await loadTimeline();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  function openSubmitModal(filingType: string) {
    setSubmitType(filingType);
    setConfirmationId("");
    setMethod("MANUAL");
    setOverride(false);
    setSubmitOpen(true);
  }

  async function confirmSubmit() {
    if (!confirmationId.trim()) { setErr("confirmationId is required"); return; }
    await setStatus("SUBMITTED", submitType, {
      confirmationId: confirmationId.trim(),
      submissionMethod: method,
      override,
    });
    setSubmitOpen(false);
  }

  function openCancelModal(filingType: string) {
    setCancelType(filingType);
    setCancelReason("");
    setCancelOverride(false);
    setCancelOpen(true);
  }

  async function confirmCancel() {
    if (!cancelOverride && !cancelReason.trim()) {
      setErr("Cancel reason is required.");
      setBanner("❌ Cancelled blocked: please enter a reason.");
      return;
    }
    await setStatus("CANCELLED", cancelType, {
      cancelReason: cancelReason.trim(),
      cancelOverride,
    });
    setCancelOpen(false);
  }

  const incident = bundle?.incident ?? null;
  const filings = useMemo(() => (bundle?.filings ?? []), [bundle]);
  const logs = bundle?.logs ?? null;
  const filingsMeta = incident?.filingsMeta ?? null;
  const timelineMeta = bundle?.timelineMeta ?? null;

  // --- Needs Attention (derived) ---
  const showAttention = useMemo(() => {
    const hasMeta = !!(bundle?.timelineMeta || bundle?.incident?.filingsMeta);
    const hasFilings = Array.isArray(bundle?.filings) && bundle.filings.length > 0;
    const hasTimeline = Array.isArray(timelineEvents) && timelineEvents.length > 0;
    const lg = bundle?.logs || {};
    const hasLogs = ((lg?.system?.length || 0) + (lg?.user?.length || 0) + (lg?.filing?.length || 0)) > 0;
    return hasMeta || hasFilings || hasTimeline || hasLogs;
  }, [bundle, timelineEvents]);

  const attentionItems = useMemo(() => {
    try {
      if (typeof computeAttention === "function") {
        const incident = bundle?.incident;
        const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
        const timelineMeta = bundle?.timelineMeta || incident?.timelineMeta;
        return computeAttention({ incident, filings, timelineMeta }) || [];
      }
      return [];
    } catch {
      return [];
    }
  }, [bundle]);

  const attentionLine = (x: any) => {
    if (!x) return "WARN: Unknown issue";
    if (typeof x === "string") return x;
    const level = String(x.level || x.severity || "WARN").toUpperCase();
    let msg = x.message || x.text || x.reason;
    if (!msg) {
      try { msg = JSON.stringify(x); } catch { msg = String(x); }
    }
    return `${level}: ${msg}`;
  };

  const attentionBlocks = useMemo(
    () =>
      (showAttention ? attentionItems : [])
        .filter((x: any) => String(x?.level || x?.severity || "").toUpperCase() === "BLOCK")
        .map(attentionLine),
    [attentionItems, showAttention]
  );

  const attentionWarns = useMemo(
    () =>
      (showAttention ? attentionItems : [])
        .filter((x: any) => String(x?.level || x?.severity || "").toUpperCase() === "WARN")
        .map(attentionLine),
    [attentionItems, showAttention]
  );
  // --- end Needs Attention (derived) ---


  // --- Derived UI helpers (canonical) ---
  const safeAttention = useMemo(
    () => computeAttention({ incident, filings, timelineMeta }),
    [incident, filings, timelineMeta]
  );

  const exportBlockers = useMemo(
    () => computeExportBlockers({ incident, filings, timelineMeta, logs }),
    [incident, filings, timelineMeta, logs]
  );

      const canFixTimeline = useMemo(
    () => attentionBlocks.some((x:any) => String(x).toLowerCase().includes("timeline")),
    [attentionBlocks]
  );
  const canFixFilings = useMemo(
    () => attentionBlocks.some((x:any) => String(x).toLowerCase().includes("filing")),
    [attentionBlocks]
  );
  const canFixBoth = useMemo(() => canFixTimeline && canFixFilings, [canFixTimeline, canFixFilings]);

  const filingActionStats = useMemo(() => {
    const stats: Record<string, { count: number; last?: any }> = {};
    const arr = (logs?.filing || []) as any[];
    for (const x of arr) {
      const t = String(x.filingType || "UNKNOWN");
      stats[t] = stats[t] || { count: 0, last: null };
      stats[t].count += 1;
      if (!stats[t].last || String(x.createdAt||"") > String(stats[t].last.createdAt||"")) stats[t].last = x;
    }
    return stats;
  }, [logs]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Admin · Incident {incidentId}</h1>
        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", color:"CanvasText", opacity:0.8 }}>← Back</a>
      </div>
      <div style={{ fontSize:12, opacity:0.7, marginTop:6 }}>Org: {orgId}</div>

      <div style={{ display:"flex", gap:10, marginTop:14, flexWrap:"wrap" }}>
        <Button disabled={!!busy} onClick={() => { loadBundle(); loadRil(); }}>Refresh</Button>
        <Button disabled={!!busy} onClick={runFilings}>{busy==="filings" ? "Working…" : "Generate Filings"}</Button>
        <Button disabled={!!busy} onClick={runTimelineGen}>{busy==="timeline" ? "Working…" : "Generate Timeline"}</Button>
        <Button disabled={!!busy} onClick={runBoth}>{busy==="both" ? "Working…" : "Generate Both"}</Button>
        <Button disabled={!!busy} onClick={() => setExportOpen(true)}>Export Packet</Button>
        <a style={{ textDecoration:"none", color:"CanvasText" }} href={`/admin/usage?orgId=${encodeURIComponent(orgId)}`}>
          <Button disabled={false}>Usage →</Button>
        </a>
      </div>

      <div style={{ marginTop: 16, display:"grid", gap:16, gridTemplateColumns:"repeat(auto-fit, minmax(320px, 1fr))" }}>
        <PanelCard title="Filing Meta"><FilingsMetaCard filingsMeta={filingsMeta} /></PanelCard>
        <PanelCard title="Timeline Meta"><TimelineMetaCard timelineMeta={timelineMeta} /></PanelCard>
      </div>

      <div style={{ marginTop: 16 }}>
        {showAttention && (
<PanelCard title="What Needs Attention">
  {(attentionBlocks.length === 0 && attentionWarns.length === 0) ? (
    <div style={{ opacity: 0.75 }}>✅ All clear. No blockers detected.</div>
  ) : (
    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
      {attentionBlocks.map((t, i) => (
        <li key={"b"+i} style={{ color: "crimson", fontWeight: 800 }}>{t}</li>
      ))}
      {attentionWarns.map((t, i) => (
        <li key={"w"+i} style={{ opacity: 0.9, fontWeight: 700 }}>{t}</li>
      ))}
    </ul>
  )}
</PanelCard>
)}
      </div>

      {banner && (
        <div style={{
          marginTop: 10,
          padding:"10px 12px",
          borderRadius:12,
          border:"1px solid color-mix(in oklab, CanvasText 18%, transparent)",
          background:"color-mix(in oklab, CanvasText 4%, transparent)",
          fontWeight:800
        }}>{banner}</div>
      )}
      {err && <pre style={{ marginTop: 12, color:"crimson", whiteSpace:"pre-wrap" }}>{err}</pre>}

      <div style={{ marginTop: 18, display:"grid", gap:16 }}>
        <PanelCard title="Timeline">
          <ul style={{ margin:0, paddingLeft:18 }}>
            {timelineEvents.map((e:any) => (
              <li key={e.id} style={{ marginBottom:10 }}>
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
                  <th style={{ padding:"10px 8px" }}>Workflow</th>
                  <th style={{ padding:"10px 8px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filings.map((f:any) => {
                  const st = String(f.status || "DRAFT").toUpperCase();
                  const key = String(f.type || f.id);
                  const stInfo = filingActionStats[key];
                  const last = stInfo?.last;
                  const label = last?.from ? `${last.from}→${last.to}` : (last?.action || "—");
                  return (
                    <tr key={f.id} style={{ borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
                      <td style={{ padding:"10px 8px", fontWeight:900 }}>{f.type || f.id}</td>
                      <td style={{ padding:"10px 8px" }}><span style={statusPillStyle(st)}>{st}</span></td>
                      <td style={{ padding:"10px 8px", fontFamily:"ui-monospace, Menlo, monospace", opacity:0.85 }}>{shortHash(f?.payloadHash?.value)}</td>
                      <td style={{ padding:"10px 8px", opacity:0.85 }}>{fmtTs(f.generatedAt)}</td>
                      <td style={{ padding:"10px 8px" }}>
                        <Button disabled={!f?.payloadHash?.value} onClick={() => copyText(String(f?.payloadHash?.value || ""))}>Copy hash</Button>
                      </td>
                      <td style={{ padding:"10px 8px", display:"flex", gap:8, flexWrap:"wrap" }}>
                        <Button disabled={!!busy} onClick={() => setStatus("READY", (f.type || f.id))}>READY</Button>
                        <Button disabled={!!busy || st !== "READY"} onClick={() => openSubmitModal((f.type || f.id))}>SUBMITTED</Button>
                        <Button disabled={!!busy} onClick={() => setStatus("AMENDED", (f.type || f.id))}>AMENDED</Button>
                        <Button disabled={!!busy} onClick={() => openCancelModal((f.type || f.id))}>CANCELLED</Button>
                      </td>
                      <td style={{ padding:"10px 8px", fontSize:12, opacity:0.85 }}>
                        {!stInfo?.count ? "—" : (
                          <div style={{ display:"grid", gap:2 }}>
                            <div><b>{stInfo.count}</b> actions</div>
                            <div style={{ opacity:0.8 }}>{label} · {fmtTs(last?.createdAt)}</div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filings.length === 0 && (
                  <tr><td colSpan={7} style={{ padding:12, opacity:0.7 }}>No filings yet. Click “Generate Filings”.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </PanelCard>

        <PanelCard title="Incident Summary">
          <IncidentSummaryCard incident={incident} />
        </PanelCard>

        <PanelCard title="Filing Actions">
          <FilingActionsPanel logs={logs} />
        </PanelCard>

        <PanelCard title="System & User Logs">
          <SystemUserLogsPanel logs={logs} />
        </PanelCard>

        <PanelCard title="Incident JSON (debug)">
          <pre style={{ margin:0, whiteSpace:"pre-wrap", opacity:0.9 }}>{incident ? JSON.stringify(incident, null, 2) : "—"}</pre>
        </PanelCard>
      </div>

      <Modal open={exportOpen} title={"Export Incident Packet"} onClose={() => setExportOpen(false)}>
  <div style={{ marginTop: 10, display:"grid", gap:12 }}>
    {attentionBlocks.length > 0 && (
      <div style={{ border: "1px solid color-mix(in oklab, red 25%, transparent)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6, color: "crimson" }}>Blocking issues (export):</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          {attentionBlocks.map((x:any, i:number) => (
            <li key={i} style={{ color:"crimson", fontWeight:800 }}>{renderAttentionItemLocal(x)}</li>
          ))}
        </ul>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          Fix blockers above (Generate Filings/Timeline) before exporting.
        </div>
      </div>
    )}

    {attentionWarns.length > 0 && (
      <div style={{ border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>Warnings (export allowed):</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          {attentionWarns.map((x:any, i:number) => (
  <li key={i} style={{ opacity: 0.9, fontWeight: 700 }}>{renderAttentionItemLocal(x)}</li>
))}
        </ul>
      </div>
    )}

    {(attentionBlocks.length === 0 && attentionWarns.length === 0) && (
      <div style={{ opacity: 0.75 }}>✅ Export preflight: clean.</div>
    )}

    <div style={{ display:"grid", gap:10 }}>
      <div style={{ opacity: 0.85 }}>
        Export will include: Incident summary, Timeline, Filings, Logs, Hashes.
      </div>

      <label style={{ fontSize: 12, opacity: 0.8 }}>Purpose</label>
      <select
        value={exportPurpose}
        onChange={(e)=>setExportPurpose(e.target.value)}
        style={{
          padding: 10,
          borderRadius: 12,
          border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
          background: "Canvas",
          color: "CanvasText",
          fontSize: 14
        }}
      >
        <option value="OPS">OPS (internal)</option>
        <option value="REGULATORY">REGULATORY (audit-ready)</option>
        <option value="CUSTOMER">CUSTOMER (shareable)</option>
      </select>
    </div>

    <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
      <Button disabled={!!busy} onClick={() => setExportOpen(false)}>Close</Button>
      <Button
        disabled={!!busy || attentionBlocks.length > 0}
        onClick={async () => {
          setBusy("export"); setErr(null); setBanner(null);
          try {
            const out = await postFn("exportIncidentPacketV1", { incidentId, orgId, purpose: exportPurpose, requestedBy: "admin_ui" });
            if (!out.ok) throw new Error(out.error || "exportIncidentPacketV1 failed");
            setBanner("✅ Export packet generated");
            if (out.downloadUrl) await copyText(out.downloadUrl);
          } catch (e:any) {
            setErr(e.message || String(e));
          } finally {
            setBusy(null);
          }
        }}
      >
        Export Packet
      </Button>
    </div>
  </div>
</Modal>

      <Modal open={submitOpen} title={`Mark SUBMITTED · ${submitType}`} onClose={() => setSubmitOpen(false)}>
        <div style={{ display:"grid", gap:10 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Confirmation ID (required)</label>
          <input
            value={confirmationId}
            onChange={(e)=>setConfirmationId(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "Canvas",
              color: "CanvasText",
              fontSize: 14
            }}
            placeholder="e.g. FCC-123456"
          />

          <label style={{ fontSize: 12, opacity: 0.8 }}>Submission Method</label>
          <select
            value={method}
            onChange={(e)=>setMethod(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "Canvas",
              color: "CanvasText",
              fontSize: 14
            }}
          >
            <option value="MANUAL">MANUAL</option>
            <option value="UPLOAD">UPLOAD</option>
            <option value="API">API</option>
          </select>

          <label style={{ display:"flex", gap:10, alignItems:"center", marginTop: 6 }}>
            <input type="checkbox" checked={override} onChange={(e)=>setOverride(e.target.checked)} />
            <span style={{ fontSize: 13, opacity: 0.85 }}>Override READY requirement (admin only)</span>
          </label>

          <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop: 10 }}>
            <Button disabled={false} onClick={() => setSubmitOpen(false)}>Cancel</Button>
            <Button disabled={!!busy} onClick={confirmSubmit}>{busy ? "Working…" : "Confirm Submitted"}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={cancelOpen} title={`Cancel Filing · ${cancelType}`} onClose={() => setCancelOpen(false)}>
        <div style={{ display:"grid", gap:10 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Reason (required)</label>
          <input
            value={cancelReason}
            onChange={(e)=>setCancelReason(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "Canvas",
              color: "CanvasText",
              fontSize: 14
            }}
            placeholder="e.g. duplicate incident / false alarm / filed elsewhere"
          />

          <label style={{ display:"flex", gap:10, alignItems:"center", marginTop: 6 }}>
            <input type="checkbox" checked={cancelOverride} onChange={(e)=>setCancelOverride(e.target.checked)} />
            <span style={{ fontSize: 13, opacity: 0.85 }}>Override reason requirement (admin only)</span>
          </label>

          <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop: 10 }}>
            <Button disabled={false} onClick={() => setCancelOpen(false)}>Back</Button>
            <Button disabled={!!busy} onClick={confirmCancel}>{busy ? "Working…" : "Confirm Cancelled"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
