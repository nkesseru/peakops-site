import Link from "next/link";

const NAV_ITEMS = [
  { href: "/admin/stormwatch", label: "StormWatch" },
  { href: "/admin/incidents", label: "Incidents" },
  { href: "/admin/contracts", label: "Contracts" },
  { href: "/admin/queue", label: "Queue" },
  { href: "/admin/usage", label: "Usage" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          height: 44,
          background: "#050505",
          borderBottom: "1px solid #1a1a1a",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Link
            href="/"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              color: "#C8A84E",
              textDecoration: "none",
              marginRight: 8,
            }}
          >
            PEAKOPS
          </Link>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                fontSize: 12,
                color: "#888",
                textDecoration: "none",
              }}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <form method="POST" action="/api/admin/logout">
          <button
            type="submit"
            style={{
              fontSize: 11,
              color: "#555",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Logout
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
