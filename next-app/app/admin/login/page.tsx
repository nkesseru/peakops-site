import Link from "next/link";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string }>;
}) {
  const params = await searchParams;
  const error = params?.error;
  const redirectTo = params?.redirectTo || "/admin/stormwatch";

  return (
    <div
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
      {/* Wordmark */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: "#333",
          marginBottom: 24,
        }}
      >
        PEAKOPS
      </div>

      {/* Login card */}
      <div
        style={{
          maxWidth: 420,
          width: "100%",
          background: "#0a0a0a",
          borderRadius: 12,
          border: "1px solid #1a1a1a",
          padding: 24,
        }}
      >
        <h1
          style={{
            fontSize: 24,
            fontWeight: 600,
            marginBottom: 8,
            color: "#fff",
          }}
        >
          Operator Login
        </h1>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: "#C8A84E", fontWeight: 600, letterSpacing: "0.04em" }}>
            PeakOps &bull; StormWatch Dashboard
          </div>
          <div style={{ fontSize: 12, color: "#777", marginTop: 2 }}>
            Real-time operations monitoring and system health
          </div>
        </div>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
          Enter the admin password to continue.
        </p>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "#fecaca",
              background: "rgba(248,113,113,0.10)",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 12,
            }}
          >
            Incorrect password. Please try again.
          </div>
        )}

        <form
          method="POST"
          action="/api/admin/login"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <input
            type="password"
            name="password"
            placeholder="Admin password"
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #1a1a1a",
              background: "#050505",
              color: "#ddd",
              fontSize: 14,
            }}
            required
          />
          <input type="hidden" name="redirectTo" value={redirectTo} />
          <button
            type="submit"
            style={{
              marginTop: 4,
              padding: "10px 12px",
              borderRadius: 8,
              border: "none",
              background: "#C8A84E",
              color: "#000",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Enter StormWatch
          </button>
        </form>
      </div>

      {/* Back link */}
      <Link
        href="/"
        style={{
          marginTop: 20,
          fontSize: 11,
          color: "#444",
          textDecoration: "none",
        }}
      >
        Back to PeakOps
      </Link>
    </div>
  );
}
