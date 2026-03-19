"use client";

import React, { useMemo } from "react";
import { useWorkflowState } from "./useWorkflowState";
import WorkflowStepCard from "./WorkflowStepCard";

export default function GuidedWorkflowPanel(props: {
  orgId: string;
  incidentId: string;
}) {
  const { orgId, incidentId } = props;
  const { busy, err, workflow, refresh, setLocalStatus } = useWorkflowState(orgId, incidentId);

  const steps = workflow?.steps || [];
  const pct = useMemo(() => {
    if (!steps.length) return 0;
    const done = steps.filter(s => String(s.status) === "DONE").length;
    return Math.round((done / steps.length) * 100);
  }, [steps]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 950, letterSpacing: -0.2 }}>Guided Workflow</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length ? `${steps.length} steps · ${pct}% complete` : "No steps yet."}
          </div>
        </div>

        <button
          onClick={refresh}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            fontWeight: 900,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {!!err && (
        <div style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid color-mix(in oklab, red 28%, transparent)",
          background: "color-mix(in oklab, red 10%, transparent)",
          color: "crimson",
          fontWeight: 900,
          fontSize: 13
        }}>
          {err}
        </div>
      )}

      {steps.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {steps.map((s, idx) => (
            <WorkflowStepCard
              key={String(s.key || idx)}
              step={s}
              index={idx}
              defaultOpen={idx === 0}
              onSetStatus={(key, st) => setLocalStatus(String(key), st)}
            />
          ))}
        </div>
      ) : (
        <div style={{ padding: 12, opacity: 0.75 }}>No workflow steps.</div>
      )}
    </div>
  );
}
