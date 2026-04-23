"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowStatus, WorkflowStep } from "./useWorkflowState";

const pill = (bg: string, fg: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  background: bg,
  color: fg,
  border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
});

const btn = (active: boolean): React.CSSProperties => ({
  padding: "7px 10px",
  borderRadius: 10,
  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
  background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
  color: "CanvasText",
  fontWeight: 800,
  cursor: "pointer",
});

function statusMeta(s: WorkflowStatus) {
  if (s === "DONE") return { label: "DONE", bg: "color-mix(in oklab, lime 22%, transparent)", fg: "CanvasText" };
  if (s === "DOING") return { label: "DOING", bg: "color-mix(in oklab, gold 24%, transparent)", fg: "CanvasText" };
  return { label: "TODO", bg: "color-mix(in oklab, CanvasText 10%, transparent)", fg: "CanvasText" };
}

export default function WorkflowStepCard(props: {
  step: WorkflowStep;
  index: number;
  defaultOpen?: boolean;
  onSetStatus: (key: string, status: WorkflowStatus) => void;
}) {
  const { step, index, defaultOpen, onSetStatus } = props;
  const [open, setOpen] = useState(!!defaultOpen);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState<number>(0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.scrollHeight));
    ro.observe(el);
    setH(el.scrollHeight);
    return () => ro.disconnect();
  }, []);

  const s = (step.status || "TODO") as WorkflowStatus;
  const meta = useMemo(() => statusMeta(s), [s]);

  return (
    <div
      style={{
        borderRadius: 16,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "transparent",
          border: "none",
          color: "CanvasText",
          cursor: "pointer",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 950, fontSize: 15 }}>
              {index + 1}. {step.title || step.key}
            </div>
            <span style={pill(meta.bg, meta.fg)}>{meta.label}</span>
          </div>
          {!!step.hint && (
            <div style={{ opacity: 0.8, fontSize: 13, lineHeight: 1.25 }}>{step.hint}</div>
          )}
        </div>

        <div style={{ opacity: 0.7, fontWeight: 900 }}>
          {open ? "–" : "+"}
        </div>
      </button>

      <div
        style={{
          maxHeight: open ? h + 20 : 0,
          opacity: open ? 1 : 0,
          transition: "max-height 260ms ease, opacity 220ms ease",
          overflow: "hidden",
        }}
      >
        <div ref={bodyRef} style={{ padding: "0 14px 14px 14px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btn(s === "TODO")} onClick={() => onSetStatus(step.key, "TODO")}>TODO</button>
            <button style={btn(s === "DOING")} onClick={() => onSetStatus(step.key, "DOING")}>DOING</button>
            <button style={btn(s === "DONE")} onClick={() => onSetStatus(step.key, "DONE")}>DONE</button>
          </div>

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Saved locally so techs don’t lose their place.
          </div>
        </div>
      </div>
    </div>
  );
}
