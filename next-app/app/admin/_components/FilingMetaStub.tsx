"use client";

import React from "react";

export default function FilingMetaStub(props: { incident?: any }) {
  const incident = props.incident || null;
  const filingsMeta = incident?.filingsMeta ?? null;
  const timelineMeta = incident?.timelineMeta ?? null;

  return (
    <div
      style={{
        marginTop: 10,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        padding: 12,
      }}
    >
      <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet State (stub)</div>

      <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
        <div>
          <span style={{ opacity: 0.7 }}>filingsMeta:</span>{" "}
          {filingsMeta ? "✅ present" : "—"}
        </div>
        <div>
          <span style={{ opacity: 0.7 }}>timelineMeta:</span>{" "}
          {timelineMeta ? "✅ present" : "—"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          (Stub) This becomes the canonical packet readiness panel.
        </div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          View meta JSON
        </summary>
        <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify({ filingsMeta, timelineMeta }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
