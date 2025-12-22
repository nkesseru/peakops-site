// src/app/admin/login/page.tsx
import styles from "../stormwatch/stormwatch.module.css";

export default function AdminLoginPage({
  searchParams,
}: {
  searchParams?: { error?: string; redirectTo?: string };
}) {
  const error = searchParams?.error;
  const redirectTo = searchParams?.redirectTo || "/admin/stormwatch";

  return (
    <div className={styles.page}>
      <div className={styles.wrapper}>
        <div
          style={{
            maxWidth: 420,
            margin: "80px auto 0",
            background: "rgba(15,23,42,0.85)",
            borderRadius: 12,
            border: "1px solid #1e293b",
            padding: 24,
          }}
        >
          <h1
            style={{
              fontSize: 24,
              fontWeight: 600,
              marginBottom: 8,
              color: "#f1f5f9",
            }}
          >
            StormWatch Login
          </h1>
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
            Private PeakOps dashboard. Enter the admin password to continue.
          </p>

          {error && (
            <div
              style={{
                fontSize: 12,
                color: "#fecaca",
                background: "rgba(248,113,113,0.12)",
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
                border: "1px solid #1e293b",
                background: "#020617",
                color: "#e2e8f0",
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
                background:
                  "linear-gradient(135deg, #3b82f6, #22c55e)", // PeakOps storm gradient
                color: "#0b1120",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Enter StormWatch
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
