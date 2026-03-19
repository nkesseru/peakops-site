"use client";


import GuidedWorkflowPanel from "../_components/GuidedWorkflowPanel";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../_components/AdminNav";
function pill(active: boolean) {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
  } as const;
}

function Panel({ title, children }: { title: string; children: any }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontWeight: 950, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

type WFStep = { key: string; title?: string; hint?: string; status?: string };
type WFResp = { ok: boolean; orgId?: string; incidentId?: string; workflow?: { version?: string; steps?: WFStep[] }; error?: string };

export default function AdminIncidentDetail() {
  const sp = useSearchParams();
  const params = useParams() as any;

  const incidentId = String(params?.id || "inc_TEST");
  const orgId = sp.get("orgId") || "org_001";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<WFResp | null>(null);

  async function load() {
  setBusy(true);
  setErr("");
  try {
    const url =
      `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;

    const r = await fetch(url);
    const text = await r.text();

    // harden: don’t assume JSON
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`Workflow API returned non-JSON (HTTP ${r.status})`);
    }

    if (!j?.ok) throw new Error(j?.error || "getWorkflowV1 failed");
    setWf(j);
  } catch (e: any) {
    setErr(String(e?.message || e));
    setWf(null);
  } finally {
    setBusy(false);
  }
}

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps = useMemo(() => (wf?.workflow?.steps || []), [wf]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <AdminNav orgId={orgId} incidentId={incidentId} />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Incident</div>
          
	<Panel title="Guided Workflow">
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
    <div style={{ fontSize: 12, opacity: 0.8 }}>
      Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
    </div>
    <button style={pill(false)} onClick={load} disabled={busy}>
      {busy ? "Loading…" : "Refresh"}
    </button>
  </div>

  {err ? (
    <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>
  ) : null}

  {/* This component can do its own fetch too, but passing context is fine */}
  <div style={{ marginTop: 10 }}>
    <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
  </div>

  {/* Optional: show raw JSON for debugging */}
  {wf?.workflow?.steps?.length ? (
    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
      Loaded <b>{wf.workflow.steps.length}</b> steps.
    </div>
  ) : null}
</Panel>

      <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
        <Panel title="Filing Meta">
          <div style={{ opacity: 0.7 }}>Not generated yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Evidence Locker">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Timeline">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Filings">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>
      </div>
    </div>





  );
}
