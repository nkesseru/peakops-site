"use client";

import { useEffect } from "react";

export default function RefreshBar() {
  // manual refresh
  function refreshNow() {
    window.location.reload();
  }

  // auto-refresh every 10 minutes
  useEffect(() => {
    const id = setInterval(() => {
      window.location.reload();
    }, 600000); // 600,000 ms = 10 minutes

    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginBottom: "12px",
      }}
    >
      <button
        type="button"
        onClick={refreshNow}
        style={{
          padding: "8px 14px",
          borderRadius: "8px",
          background:
            "linear-gradient(135deg, #3b82f6, #22c55e)", // PeakOps storm gradient
          color: "#0b1120",
          fontWeight: 600,
          fontSize: "13px",
          border: "none",
          cursor: "pointer",
        }}
      >
        Refresh
      </button>
    </div>
  );
}
