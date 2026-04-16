import Link from "next/link";

export default function RootPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 30% 20%, #0f172a, #0b0f19 70%)",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: 24,
      }}
    >
      {/* Wordmark */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: "#94a3b8",
          textTransform: "uppercase" as const,
          marginBottom: 12,
        }}
      >
        PeakOps
      </div>

      {/* Value proposition */}
      <h1
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: "#f1f5f9",
          textAlign: "center",
          margin: "0 0 8px",
          lineHeight: 1.3,
        }}
      >
        Operational records built in real time.
      </h1>
      <p
        style={{
          fontSize: 14,
          color: "#64748b",
          textAlign: "center",
          maxWidth: 460,
          lineHeight: 1.5,
          margin: "0 0 40px",
        }}
      >
        PeakOps turns field work into audit-ready, filing-ready records without
        reconstruction.
      </p>

      {/* CTAs */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <Link
          href="/admin/login"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "12px 28px",
            borderRadius: 8,
            background: "linear-gradient(135deg, #3b82f6, #22c55e)",
            color: "#0b1120",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            minWidth: 160,
          }}
        >
          Operator Login
        </Link>
        <span
          aria-disabled="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "12px 28px",
            borderRadius: 8,
            border: "1px solid #1e293b",
            background: "rgba(15, 23, 42, 0.4)",
            color: "#475569",
            fontSize: 14,
            fontWeight: 500,
            minWidth: 160,
            cursor: "default",
          }}
        >
          Contractor Access
        </span>
      </div>

      {/* Subtle internal access */}
      <div style={{ marginTop: 64, fontSize: 11, color: "#334155" }}>
        <Link
          href="/admin/login"
          style={{ color: "#334155", textDecoration: "none" }}
        >
          Internal
        </Link>
      </div>
    </main>
  );
}
