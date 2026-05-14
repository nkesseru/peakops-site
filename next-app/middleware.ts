import { NextRequest, NextResponse } from "next/server";

const LOGIN_PATH = "/admin/login";
const AUTH_COOKIE = "stormwatch-auth";
const DEV_CANONICAL_HOST = "localhost";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const { pathname } = request.nextUrl;

  // Canonical host enforcement (dev only)
  if (
    process.env.NODE_ENV !== "production" &&
    host.startsWith("127.0.0.1")
  ) {
    const canonical = request.nextUrl.clone();
    canonical.hostname = DEV_CANONICAL_HOST;
    return NextResponse.redirect(canonical);
  }

  const cookie = request.cookies.get(AUTH_COOKIE)?.value;
  const isAuthenticated = cookie === "ok";

  // If already authenticated, skip past the login page
  if (pathname === LOGIN_PATH) {
    if (isAuthenticated) {
      const redirectTo =
        request.nextUrl.searchParams.get("redirectTo") || "/admin/stormwatch";
      const dest = request.nextUrl.clone();
      dest.pathname = redirectTo;
      dest.searchParams.delete("redirectTo");
      return NextResponse.redirect(dest);
    }
    return NextResponse.next();
  }

  // Gate all other /admin/* routes
  if (isAuthenticated) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = LOGIN_PATH;
  loginUrl.searchParams.set("redirectTo", pathname);
  return NextResponse.redirect(loginUrl);
}

// PEAKOPS_MIDDLEWARE_SCOPE_V1 (2026-04-27)
// Matcher is intentionally limited to /admin/:path*. Incident pages
// (/incidents, /incidents/[id], /incidents/[id]/{notes,review,summary,
// add-evidence}) are NOT under middleware protection — they're gated
// client-side by Firebase Auth (lib/auth.ts) and server-side by the
// Firebase ID token enforcement on /api/fn/* (lib/verifyAuth.ts +
// app/api/fn/_orgProxy.ts). Until we issue a server session cookie
// that mirrors Firebase Auth state, edge middleware has no way to see
// whether a visitor is signed in, so any /incidents/* match here would
// either let everyone through (useless) or redirect every visit to
// /admin/login (wrong destination).
export const config = {
  matcher: ["/admin/:path*"],
};
