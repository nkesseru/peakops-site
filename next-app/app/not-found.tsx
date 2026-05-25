/**
 * PEAKOPS_NOT_FOUND_ESCAPE_V1 (PR 67)
 *
 * Custom 404 page replacing the default Next.js shell. Previously a
 * mistyped or stale URL landed the user on the framework's bare
 * "404 - This page could not be found" with no way back. This page
 * matches the PEAKOPS dossier voice and gives two clear exits:
 * Dashboard (for signed-in users) and Sign in (for anonymous /
 * expired sessions).
 *
 * Server component on purpose — we can't cheaply distinguish auth
 * state here, but showing both buttons is harmless: the signed-in
 * user clicks Dashboard, the signed-out user clicks Sign in (and
 * the signed-in user who clicks Sign in just lands on /login, which
 * bounces them back). No useAuth, no client JS, no flicker.
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            PeakOps
          </div>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-white">
            Page not found
          </h1>
          <p className="text-[14px] text-gray-400 leading-relaxed">
            We couldn&apos;t find that record. It may have moved, been
            sealed under a different identifier, or never existed.
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 pt-2">
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-full text-[12px] font-medium bg-white text-black hover:bg-white/90 transition-colors"
          >
            Back to Dashboard
          </Link>
          <Link
            href="/login"
            className="px-4 py-2 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
