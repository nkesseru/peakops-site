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
        background: "radial-gradient(ellipse at 50% 0%, #111 0%, #000 70%)",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: 24,
      }}
    >
      {/* Eyebrow */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          color: "#666",
          textTransform: "uppercase" as const,
          marginBottom: 10,
        }}
      >
        Operational Record System
      </div>

      {/* Wordmark */}
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "0.22em",
          color: "#C8A84E",
          marginBottom: 24,
        }}
      >
        PEAKOPS
      </div>

      {/* Headline */}
      <h1
        style={{
          fontSize: 26,
          fontWeight: 600,
          color: "#fff",
          textAlign: "center",
          margin: "0 0 8px",
          lineHeight: 1.35,
        }}
      >
        Operational records built in real time.
      </h1>
      <p
        style={{
          fontSize: 14,
          color: "#777",
          textAlign: "center",
          maxWidth: 440,
          lineHeight: 1.6,
          margin: "0 0 36px",
        }}
      >
        PeakOps turns field work into audit-ready, filing-ready records without
        reconstruction.
      </p>

      {/* CTAs */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Link
          href="/admin/login"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "12px 32px",
            borderRadius: 6,
            background: "#C8A84E",
            color: "#000",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            minWidth: 200,
            letterSpacing: "0.02em",
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
            padding: "12px 32px",
            borderRadius: 6,
            border: "1px solid #222",
            background: "transparent",
            color: "#555",
            fontSize: 14,
            fontWeight: 500,
            minWidth: 200,
            cursor: "default",
          }}
        >
          Contractor Access
        </span>
        <p
          style={{
            fontSize: 11,
            color: "#444",
            textAlign: "center",
            maxWidth: 320,
            lineHeight: 1.5,
            margin: "2px 0 0",
          }}
        >
          Portal access is being finalized. Contact your administrator if you
          need access.
        </p>
      </div>

      {/* Trust line */}
      <p
        style={{
          fontSize: 12,
          color: "#555",
          textAlign: "center",
          marginTop: 48,
          letterSpacing: "0.01em",
        }}
      >
        Built for field operations, infrastructure, and compliance-sensitive
        teams.
      </p>

      {/* Footer microcopy */}
      <div
        style={{
          position: "absolute",
          bottom: 24,
          fontSize: 10,
          color: "#333",
          letterSpacing: "0.02em",
        }}
      >
        Secure access to operational records and workflows.
      </div>
    </main>
  );
}
