"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type WFStatus = "TODO" | "DOING" | "DONE";

export type WFStep = {
  key: string;
  title: string;
  hint?: string;
  status?: WFStatus;
  actions?: Array<{ id: string; label: string }>;
};

function pill(status: WFStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 900,
    padding: "5px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    letterSpacing: 0.3,
  };
  if (status === "DOING") return { ...base, background: "color-mix(in oklab, gold 20%, transparent)" };
  if (status === "DONE") return { ...base, background: "color-mix(in oklab, lime 16%, transparent)" };
  return base;
}

function btn(primary?: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: primary
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 5%, transparent)",
    color: "CanvasText",
    fontWeight: 800,
    cursor: "pointer",
  };
}

export default function WorkflowStepCard(props: {
  step: WFStep;
  index: number;
  status: WFStatus;
  isOpen: boolean;
  onToggle: () => void;
  onSetStatus: (s: WFStatus) => void;
}) {
  const { step, index, status, isOpen, onToggle, onSetStatus } = props;

  const innerRef = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState<number>(0);

  // Measure content height for smooth expand/collapse
  useEffect(() => {
    if (!innerRef.current) return;
    const el = innerRef.current;

    const measure = () => setH(el.scrollHeight || 0);
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const headerStyle: React.CSSProperties = useMemo(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "12px 14px",
      borderRadius: 14,
      border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
      background: "color-mix(in oklab, CanvasText 3%, transparent)",
      cursor: "pointer",
      userSelect: "none",
    }),
    []
  );

  const bodyWrapStyle: React.CSSProperties = useMemo(
    () => ({
      overflow: "hidden",
      maxHeight: isOpen ? h + 24 : 0,
      transition: "max-height 220ms ease",
      borderRadius: 14,
      border: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
      background: "color-mix(in oklab, CanvasText 2%, transparent)",
      marginTop: 10,
    }),
    [isOpen, h]
  );

  const contentStyle: React.CSSProperties = useMemo(
    () => ({
      padding: 14,
      display: "grid",
      gap: 10,
    }),
    []
  );

  return (
    <div>
      <div style={headerStyle} onClick={onToggle} role="button" aria-expanded={isOpen}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.75, width: 26 }}>{index + 1}.</div>
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 950, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {step.title}
            </div>
            {step.hint ? <div style={{ fontSize: 12, opacity: 0.75 }}>{step.hint}</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={pill(status)}>{status}</span>
          <span style={{ fontSize: 18, opacity: 0.7, transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 160ms ease" }}>
            ›
          </span>
        </div>
      </div>

      <div style={bodyWrapStyle}>
        <div ref={innerRef} style={contentStyle}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={btn()} onClick={() => onSetStatus("TODO")}>TODO</button>
            <button style={btn()} onClick={() => onSetStatus("DOING")}>DOING</button>
            <button style={btn(true)} onClick={() => onSetStatus("DONE")}>DONE</button>
          </div>

          {step.actions?.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 900, opacity: 0.85 }}>Actions</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {step.actions.map(a => (
                  <button key={a.id} style={btn()} onClick={() => { /* wire later */ }}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
