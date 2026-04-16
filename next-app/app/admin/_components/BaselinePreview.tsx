"use client";

import React, { useMemo, useState } from "react";

export default function BaselinePreview(props: { orgId: string; incidentId: string; incident: any }) {
  const { orgId, incidentId, incident } = props;
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    return [
      { k: "orgId", v: orgId },
      { k: "incidentId", v: incidentId },
      { k: "incident", v: incident ? "loaded" : "null" },
    ];
  }, [orgId, incidentId, incident]);

  return (
    <div
      style={{
        marginTop: 10,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "10px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          background: "transparent",
          color: "CanvasText",
          border: "none",
          cursor: "pointer",
        }}
      >
        <div>
          <div style={{ fontWeight: 950 }}>Baseline Fields</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {incident ? "Incident loaded" : "Preview mode (incident not wired yet)"}
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{open ? "Hide" : "Show"}</div>
      </button>

      {open && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 6, fontSize: 12 }}>
            {rows.map((r) => (
              <React.Fragment key={r.k}>
                <div style={{ opacity: 0.7 }}>{r.k}</div>
                <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{String(r.v)}</div>
              </React.Fragment>
            ))}
          </div>

          {!incident && (
            <div style={{ marginTop: 8, fontSize: 11, opacity: 0.65 }}>
              This becomes real once we wire an Incident read endpoint — UI stays stable.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
