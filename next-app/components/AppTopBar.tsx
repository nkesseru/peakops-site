"use client";

/**
 * PEAKOPS_APP_TOP_BAR_V1 (PR 67)
 *
 * Universal "back home" affordance for every authenticated surface.
 * The app previously had no consistent way out of /team, /404, or
 * the broken /incidents/new route — users hit a dead end and had to
 * edit the URL by hand. This thin top bar fixes that.
 *
 * Voice:
 *   - calm, premium, dossier-adjacent (same vocabulary as
 *     RecordNav and Summary's eyebrow)
 *   - reads as a quiet system frame, NOT a heavy app shell
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │  PEAKOPS · Dashboard            + New incident       │
 *   └──────────────────────────────────────────────────────┘
 *
 * Left cluster:
 *   - "PEAKOPS" wordmark in amber-200/60 small-caps (matches
 *     the dossier eyebrow that runs through Summary / Review /
 *     Incident hero)
 *   - thin "·" separator
 *   - "Dashboard" link in text-gray-300 → hover text-gray-100
 *
 * Right cluster:
 *   - "+ New incident" ghost button routing to /incidents/new
 *   - "My work" deliberately deferred to keep PR 67 small
 *
 * Non-sticky. Sits at the top of the page and scrolls with the
 * body. Sticky regions on individual pages (e.g., the Incident
 * identity-hero masthead) continue to behave as before — the
 * top bar simply scrolls away under them.
 *
 * Mount per-page (inside each surface's RequireAuth tree) rather
 * than at the layout level. This keeps signed-in chrome from
 * leaking onto unauthenticated routes (/login, /auth/action) and
 * makes opt-out trivial.
 */

import { useRouter } from "next/navigation";

export default function AppTopBar() {
  const router = useRouter();

  return (
    <div className="w-full border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-11 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70 hover:text-amber-100 transition-colors"
            aria-label="PeakOps home"
          >
            PEAKOPS
          </button>
          <span aria-hidden="true" className="text-white/20 text-[11px]">
            ·
          </span>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="text-[12px] font-medium text-gray-300 hover:text-gray-100 transition-colors"
          >
            Dashboard
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.push("/incidents/new")}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
            title="Start a new operational record"
          >
            + New incident
          </button>
        </div>
      </div>
    </div>
  );
}
