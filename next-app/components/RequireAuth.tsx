"use client";

// PEAKOPS_REQUIRE_AUTH_GATE_V1 (2026-05-07)
//
// Pre-cutover auth-flash fix. Authed pages were rendering their full
// signed-in chrome (header, Sign out, Settings, Start Job, chips,
// shelves, "Not loaded yet" pill) while Firebase Auth was still
// restoring session from IndexedDB. An unauthenticated visitor
// deep-linking to /incidents?orgId=... saw the Mission Control shell
// for ~200-800 ms before the data fetch fired, hit authedFetch's
// no-token branch, and bounced to /login. That flash leaks every
// authed UI affordance to anyone with a deep link.
//
// This guard renders a neutral PEAKOPS panel while:
//   1. Auth state is restoring (`loading === true`).
//   2. Auth state has resolved to "no user" — we set sessionStorage
//      `peakops_return_to` to match the apiClient.ts authedFetch
//      pattern, then router.replace to /login.
//
// Children only render when `loading === false && user !== null`,
// so no signed-in chrome ever touches the DOM for an unauthenticated
// session.
//
// This wraps client components inside the page boundary. It does NOT
// replace the server-side claim/membership checks at /api/fn/* —
// that gate is still authoritative for data; this is a UI-trust
// affordance only.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

type Props = {
  children: React.ReactNode;
};

export default function RequireAuth({ children }: Props) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (user) return;

    // Persist returnTo so /login can bounce the user back here after
    // sign-in. Mirrors the same key (`peakops_return_to`) and
    // hardening checks (no protocol-relative, no /login self-loop)
    // used by lib/apiClient.ts's authedFetch redirect path.
    if (typeof window !== "undefined") {
      try {
        const here =
          window.location.pathname +
          window.location.search +
          window.location.hash;
        if (
          here &&
          here.startsWith("/") &&
          !here.startsWith("//") &&
          !here.startsWith("/login")
        ) {
          window.sessionStorage.setItem("peakops_return_to", here);
        }
      } catch {
        /* sessionStorage may be unavailable (private mode); fall through */
      }
    }
    router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#050505",
          color: "#f5f5f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 360, width: "100%", textAlign: "center" }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              color: "#C8A84E",
              marginBottom: 16,
            }}
          >
            PEAKOPS
          </div>
          <div style={{ fontSize: 13, color: "#b3b3b3", lineHeight: 1.55 }}>
            {loading ? "Checking session…" : "Redirecting to sign in…"}
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
