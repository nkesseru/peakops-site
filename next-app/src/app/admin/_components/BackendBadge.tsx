"use client";

import React from "react";

export default function BackendBadge(props: { ok: boolean; label?: string }) {
  const { ok, label } = props;
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: ok
          ? "color-mix(in oklab, #22c55e 18%, transparent)"
          : "color-mix(in oklab, #ef4444 18%, transparent)",
        color: "CanvasText",
        fontSize: 12,
        fontWeight: 900,
        letterSpacing: 0.2,
        userSelect: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
      title={ok ? "Backend reachable" : "Backend not reachable"}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: ok ? "#22c55e" : "#ef4444",
          display: "inline-block",
        }}
      />
      {label || (ok ? "Backend OK" : "Backend DOWN")}
    </span>
  );
}
