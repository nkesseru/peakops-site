"use client";

/**
 * PEAKOPS_MY_WORK_PLACEHOLDER_V1 (PR 75 — Workflow Spine Foundation)
 *
 * Quiet placeholder for the per-user queue surface. Establishes the
 * route and visual shape so the nav link in AppTopBar has somewhere
 * to land; the three section cards are content-shaped for the data
 * that will populate them in a future PR.
 *
 * No backend calls. No data fetching. No localStorage. No counters
 * (which would either be fake or require a fetch).
 *
 * Section shape mirrors how field records actually move through the
 * proof-workflow lifecycle:
 *   1. For your approval     — records waiting on supervisor sign-off
 *   2. Opened by you         — field records you created
 *   3. Active in field       — records currently in proof capture
 *
 * Each section card renders a calm "Coming soon" pellet plus the
 * one-line description that previews what data will land there.
 * This pattern lets the user see the queue shape now and primes
 * the data integration that follows in a later PR.
 *
 * Wrapped in RequireAuth — anonymous visitors bounce to /login.
 */

import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";

type Section = {
  key: string;
  title: string;
  description: string;
};

const SECTIONS: Section[] = [
  {
    key: "for_your_approval",
    title: "For your approval",
    description: "Records waiting on supervisor sign-off",
  },
  {
    key: "opened_by_you",
    title: "Opened by you",
    description: "Field records you created",
  },
  {
    key: "active_in_field",
    title: "Active in field",
    description: "Records currently in proof capture",
  },
];

export default function MyWorkClient() {
  return (
    <RequireAuth>
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8">
          <header className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
              Your queue
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight text-white">
              For your attention
            </h1>
            <p className="text-[14px] text-gray-400 leading-relaxed max-w-prose">
              Records assigned to you, opened by you, or awaiting your
              sign-off.
            </p>
          </header>

          <section aria-label="Queue sections" className="space-y-3">
            {SECTIONS.map((s) => (
              <article
                key={s.key}
                aria-disabled="true"
                className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4 sm:px-5 sm:py-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-gray-200">
                      {s.title}
                    </div>
                    <p className="mt-1 text-[12px] text-gray-500 leading-relaxed">
                      {s.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500 border border-white/10 rounded-full px-2 py-0.5">
                    Coming soon
                  </span>
                </div>
              </article>
            ))}
          </section>
        </div>
      </main>
    </RequireAuth>
  );
}
