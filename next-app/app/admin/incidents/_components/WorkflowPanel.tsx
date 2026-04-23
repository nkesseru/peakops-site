"use client";

import { useEffect, useState } from "react";

type Step = { key: string; title: string; status: string; hint?: string };

export default function WorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [steps, setSteps] = useState<Step[]>([]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setSteps(j.workflow?.steps || []);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setSteps([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const pill = (status: string) => {
    const isDone = status === "DONE";
    const isTodo = status === "TODO";
    return (
      <span style={{
        fontSize: 11,
        fontWeight: 900,
        padding: "4px 8px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: isDone ? "color-mix(in oklab, lime 18%, transparent)" : isTodo ? "color-mix(in oklab, orange 18%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
      }}>
        {status}
      </span>
    );
  };

  return (
    <div style={{ display:"grid", gap: 10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap: 10 }}>
        <div style={{ fontWeight: 900 }}>Guided Workflow</div>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            cursor: busy ? "not-allowed" : "pointer"
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display:"grid", gap: 8 }}>
        {steps.map(s => (
          <div key={s.key}
            style={{
              display:"grid",
              gridTemplateColumns: "180px 1fr",
              gap: 10,
              padding: 12,
              borderRadius: 14,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "color-mix(in oklab, CanvasText 4%, transparent)"
            }}
          >
            <div style={{ display:"flex", gap: 10, alignItems:"center" }}>
              <div style={{ fontWeight: 900 }}>{s.title}</div>
              {pill(s.status)}
            </div>
            <div style={{ opacity: 0.85, fontSize: 13 }}>{s.hint || ""}</div>
          </div>
        ))}
        {(!busy && !err && steps.length === 0) && (
          <div style={{ opacity: 0.7 }}>No workflow steps yet.</div>
        )}
      </div>
    </div>
  );
}
