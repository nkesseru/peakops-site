"use client";

/**
 * PEAKOPS_NEW_INCIDENT_STUB_V1 (PR 67)
 *
 * Replaces the previously broken /incidents/new route. The old
 * route fell through to the [incidentId] dynamic segment with
 * incidentId="new", triggering getIncidentV1?incidentId=new and
 * a noisy "refresh failed" console error. Worse, the front-door
 * + New incident CTA had nowhere to land, so the workflow spine
 * read as polished-but-incomplete.
 *
 * This stub gives the route a real destination — a template
 * picker placeholder — without committing to a template backend
 * or real record creation. Cards render disabled with a "Coming
 * soon" treatment so the surface communicates intent without
 * lying about capability.
 *
 * No backend calls. No getIncidentV1. No incident creation.
 * Wrapped in RequireAuth (consistent with every other authed
 * surface) so anonymous visitors bounce to /login.
 */

import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";
import { useRouter } from "next/navigation";

type Template = {
  key: string;
  title: string;
  blurb: string;
};

const TEMPLATES: Template[] = [
  {
    key: "fiber_splice_verification",
    title: "Fiber splice verification",
    blurb: "Loss readings, splice tray photos, OTDR trace, supervisor sign-off.",
  },
  {
    key: "pole_inspection",
    title: "Pole inspection",
    blurb: "Hardware, attachments, clearance, photo evidence.",
  },
  {
    key: "splice_closure",
    title: "Splice closure",
    blurb: "Closure installation, seal verification, witness evidence.",
  },
  {
    key: "custom_operational_record",
    title: "Custom operational record",
    blurb: "Free-form workflow with photo + note evidence.",
  },
];

export default function NewIncidentClient() {
  return (
    <RequireAuth>
      <Body />
    </RequireAuth>
  );
}

function Body() {
  const router = useRouter();

  return (
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8">
        <header className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Operational Templates
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight text-white">
            Choose a template to start a new record
          </h1>
          <p className="text-[14px] text-gray-400 leading-relaxed max-w-prose">
            Select an operational workflow. Template creation is coming
            soon — the picker below previews the field operations
            PeakOps will support out of the box.
          </p>
        </header>

        <section
          aria-label="Operational templates"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          {TEMPLATES.map((t) => (
            <div
              key={t.key}
              aria-disabled="true"
              className="group rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4 cursor-not-allowed select-none"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-[14px] font-semibold text-gray-300">
                  {t.title}
                </div>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500 border border-white/10 rounded-full px-2 py-0.5">
                  Coming soon
                </span>
              </div>
              <p className="mt-2 text-[12px] text-gray-500 leading-relaxed">
                {t.blurb}
              </p>
            </div>
          ))}
        </section>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="text-[12px] text-gray-400 hover:text-gray-100 transition-colors"
          >
            ← Back to dashboard
          </button>
        </div>
      </div>
    </main>
  );
}
