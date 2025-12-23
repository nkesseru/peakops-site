"use client";
import { useEffect, useState } from "react";

function Button({ children, onClick, disabled }: any) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
        background: "color-mix(in oklab, CanvasText 6%, transparent)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

export default function AdminQueuePage() {
  const [orgId, setOrgId] = useState("org_001");
  const [incidentId, setIncidentId] = useState("");
  const [jobs, setJobs] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function jget(url: string) { const r = await fetch(url); return r.json(); }
  async function jpost(url: string, body: any) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }

  async function refresh() {
    setBusy("refresh"); setErr(null);
    try {
      const out = await jget(`/api/fn/listSubmitQueue?orgId=${encodeURIComponent(orgId)}`);
      if (!out.ok) throw new Error(out.error || "listSubmitQueue failed");
      setJobs(out.jobs || []);
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function tick(dryRun: boolean) {
    setBusy(dryRun ? "tickDry" : "tick"); setErr(null);
    try {
      const out = await jget(`/api/fn/submitQueueTick?dryRun=${dryRun ? "true" : "false"}`);
      if (!out.ok) throw new Error(out.error || "tick failed");
      await refresh();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function submitAll() {
    setBusy("submitAll"); setErr(null);
    try {
      if (!incidentId.trim()) throw new Error("incidentId required");
      const out = await jpost(`/api/fn/enqueueSubmitAll`, { orgId, incidentId: incidentId.trim(), createdBy: "admin_ui" });
      if (!out.ok) throw new Error(out.error || "enqueueSubmitAll failed");
      await refresh();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function requeue(jobId: string) {
    setBusy("requeue"); setErr(null);
    try {
      const out = await jpost(`/api/fn/requeueSubmitJob`, { jobId, reason: "ui_requeue" });
      if (!out.ok) throw new Error(out.error || "requeue failed");
      await refresh();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  async function cancel(jobId: string) {
    setBusy("cancel"); setErr(null);
    try {
      const out = await jpost(`/api/fn/cancelSubmitJob`, { jobId, reason: "ui_cancel" });
      if (!out.ok) throw new Error(out.error || "cancel failed");
      await refresh();
    } catch (e:any) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Admin · Submit Queue</h1>

      <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Org</div>
        <input value={orgId} onChange={(e)=>setOrgId(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)" }} />

        <div style={{ fontSize: 12, opacity: 0.7 }}>Incident</div>
        <input value={incidentId} onChange={(e)=>setIncidentId(e.target.value)} placeholder="inc_..." style={{ padding: 8, borderRadius: 10, border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)", minWidth: 220 }} />

        <Button disabled={!!busy} onClick={refresh}>Refresh</Button>
        <Button disabled={!!busy} onClick={() => tick(true)}>Tick (dry)</Button>
        <Button disabled={!!busy} onClick={() => tick(false)}>Tick</Button>
        <Button disabled={!!busy} onClick={submitAll}>Submit All READY</Button>

        <a href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", color:"CanvasText", opacity:0.85 }}>← Incidents</a>
      </div>

      {err && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 12, border: "1px solid color-mix(in oklab, red 35%, transparent)", color: "crimson" }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 14, opacity: 0.75, fontSize: 12 }}>Jobs: {jobs.length}</div>

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {jobs.map((j:any) => (
          <div key={j.id} style={{ border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", borderRadius: 14, padding: 12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
              <div style={{ fontWeight: 900 }}>{j.id}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{j.status} · {j.filingType} · attempts {j.attempts}/{j.maxAttempts}</div>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.9 }}>
              <div><b>Incident:</b> {j.incidentId}</div>
              <div><b>NextAttemptAt:</b> {String(j.nextAttemptAt?.toDate?.() || j.nextAttemptAt || "—")}</div>
              <div><b>Lock:</b> {j.lockedBy ? `${j.lockedBy}` : "—"}</div>
              {j.lastError && <div style={{ color:"crimson" }}><b>Error:</b> {j.lastError}</div>}
            </div>
            <div style={{ marginTop: 10, display:"flex", gap:10, flexWrap:"wrap" }}>
              <Button disabled={!!busy} onClick={() => requeue(j.id)}>Requeue</Button>
              <Button disabled={!!busy} onClick={() => cancel(j.id)}>Cancel</Button>
            </div>
          </div>
        ))}
        {jobs.length === 0 && <div style={{ opacity: 0.7 }}>No queue jobs.</div>}
      </div>
    </div>
  );
}
