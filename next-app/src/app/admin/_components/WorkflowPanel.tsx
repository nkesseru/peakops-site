"use client";

import React, { useEffect, useMemo, useState } from "react";
import WorkflowStepCard, { WorkflowStep } from "./WorkflowStepCard";

type WorkflowResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  asOf?: string;
  workflow?: { version?: string; steps?: WorkflowStep[] };
  error?: string;
};

export default function WorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [data, setData] = useState<WorkflowResponse | null>(null);

  const storageKey = useMemo(() => `wf_steps:${orgId}:${incidentId}`, [orgId, incidentId]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setOverrides(JSON.parse(raw));
    } catch {}
  }, [storageKey]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(overrides)); } catch {}
  }, [overrides, storageKey]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      const j = (await r.json()) as WorkflowResponse;
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setData(j);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps = useMemo(() => {
    const arr = (data?.workflow?.steps || []) as WorkflowStep[];
    return arr.map((s) => {
      const key = String(s.key || "");
      const override = key ? overrides[key] : undefined;
      return { ...s, status: override ?? s.status ?? "TODO" };
    });
  }, [data, overrides]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
            cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {steps.map((step, idx) => (
          <WorkflowStepCard
            key={String(step.key || idx)}
            step={step as any}
            index={idx}
            onSetStatus={(k, st) => setOverrides((prev) => ({ ...prev, [String(k)]: String(st) }))}
          />
        ))}
      </div>
    </div>
  );
}
