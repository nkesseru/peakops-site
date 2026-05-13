"use client";

import React from "react";

export default function CodeBlock({
  text,
  title,
  right,
  minHeight = 240,
}: {
  text: string;
  title?: string;
  right?: React.ReactNode;
  minHeight?: number;
}) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 2%, transparent)",
        overflow: "hidden",
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            padding: "10px 12px",
            borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
          }}
        >
          <div style={{ fontWeight: 900, opacity: 0.9 }}>{title || ""}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
        </div>
      )}

      <pre
        style={{
          margin: 0,
          padding: 12,
          minHeight,
          fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: "pre",
          overflow: "auto",
        }}
      >
        {text}
      </pre>
    </div>
  );
}
