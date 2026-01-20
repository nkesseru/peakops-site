"use client";

import React, { useEffect, useMemo, useState } from "react";
import FilingMetaStub from "../../_components/FilingMetaStub";
import TimelinePreviewMock from "../../_components/TimelinePreviewMock";
import BackendBadge from "../../_components/BackendBadge";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../_components/AdminNav";
import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";
import ValidationPanel from "../../_components/ValidationPanel";


function btn(primary: boolean): React.CSSProperties {
  return {
    border: "1px solid rgba(255,255,255,0.14)",
    background: primary ? "rgba(34,197,94,0.18)" : "rgba(255,255,255,0.06)",
    color: "inherit",
    padding: "9px 12px",
    borderRadius: 999,
    fontWeight: 800,
    fontSize: 12,
    cursor: "pointer",
    opacity: 1,
  };
}


function isImmutable409(status: number, bodyText: string) {
  return status === 409 && (bodyText || "").includes("IMMUTABLE");
}



function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>{props.title}</div>
      {props.children}
    </div>
  );
}

function panelCardStyle(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 16,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    userSelect: "none",
  };
}

type WFResp = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  workflow?: { version?: string; steps?: any[] };
  error?: string;
};

export default function AdminIncidentDetail() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params?.id || "inc_TEST");

  
  async function hydrateLock() {
    try {
      const u = `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok && typeof j.immutable === "boolean") setImmutable(!!j.immutable);
    } catch {
      // swallow
    }
  }


  const [immutable, setImmutable] = React.useState<boolean>(false);

  const [busy, setBusy] = React.useState<string>("");

  async function runAction(kind: "timeline" | "filings" | "export") {
    if (busy) return;
    try {
      setBusy(kind);
      const base = kind === "timeline"
        ? `/api/fn/generateTimelineV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : kind === "filings"
        ? `/api/fn/generateFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`;

      const method = kind === "export" ? "GET" : "POST";
      const r = await fetch(base, { method });
      const t = await r.text();

      if (isImmutable409(r.status, t)) {
        setErr("Locked: this incident is finalized (immutable). You can only Export with force=1 (admin).");
        setBusy("");
        return;
      }

      let j: any = null;
      try { j = JSON.parse(t); } catch {}
      if (!r.ok || (j && j.ok === false)) {
        const msg = j?.error || t || `HTTP ${r.status}`;
        alert(`${kind.toUpperCase()} failed: ${msg}`);
        return;
      }
    } finally {
      setBusy("");
    }
  }

  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<WFResp | null>(null);

  const stepsCount = useMemo(() => wf?.workflow?.steps?.length || 0, [wf]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url);
      const text = await r.text();

      let j: WFResp;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status})`);
      }
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setWf(j);
    } catch (e: any) {
      setWf(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void hydrateLock();
 void load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <AdminNav orgId={orgId} />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Incident</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b> · Steps: <b>{stepsCount}</b>
          </div>
        </div>

        
<div style={{ display:"flex", gap:10, alignItems:"center" }}>
  <BackendBadge orgId={orgId} incidentId={incidentId} />
  <button style={pill(false)} onClick={load} disabled={busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
</div>
      </div>

      {err ? (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        
      <div style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 950 }}>Field Actions</div>
          {immutable && (
            <div style={{ fontSize: 12, fontWeight: 900, padding: "6px 10px", borderRadius: 999, background: "rgba(34,197,94,0.18)", border: "1px solid rgba(34,197,94,0.35)" }}>
              ✅ FINALIZED (Immutable)
            </div>
          )}
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button disabled={immutable || busy === "timeline"} onClick={() => runAction("timeline")} style={btn(false)}>
            {busy === "timeline" ? "Working…" : "Generate Timeline"}
          </button>
          <button disabled={immutable || busy === "filings"} onClick={() => runAction("filings")} style={btn(false)}>
            {busy === "filings" ? "Working…" : "Generate Filings"}
          </button>
          <button disabled={immutable || busy === "export"} onClick={() => runAction("export")} style={btn(true)}>
            {busy === "export" ? "Working…" : "Export Packet"}
          </button>
          <a style={{ ...btn(false), textDecoration: "none", display: "inline-flex", alignItems: "center" }} href={`/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`}>
            Open Artifact →
          </a>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          Tip: Run Timeline → Filings → Export. Then verify ZIP and finalize on the Artifact page.
        </div>
      </div>

<div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 8 }}>Guided Workflow</div>
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        

        
        


<TimelinePreviewMock orgId={orgId} incidentId={incidentId} />
<FilingMetaStub incident={wf?.incident} />
{/* PACKET_STATE_STUB */}
</div>
      </div>

      <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Filing Meta</div>
          <div style={{ opacity: 0.7 }}>Not generated yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Evidence Locker</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Timeline</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Filings</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
      </div>
    </div>
  );
}
