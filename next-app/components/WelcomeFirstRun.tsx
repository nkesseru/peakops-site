// PR 134A.1 — Welcome surface for first-time customer admins.
//
// The Butler dry-run (Action 2) identified that a brand-new customer
// admin lands on /dashboard with zero incidents + a "+ New field
// record" button and zero orientation. This card surfaces the four
// signals an admin needs in the first 30 seconds: activation
// succeeded, starter template ready, teammates invited, what to do
// next.
//
// Visibility rules — deliberately narrow, no framework:
//   - shows only when the org has zero incidents (auto-hides after
//     first real workflow data)
//   - dismissible via localStorage flag scoped to {orgId}
//   - silently no-ops on fetch failure (never blocks the dashboard)

"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/apiClient";

interface Props {
  orgId: string;
}

interface OnboardingStatus {
  ok: boolean;
  orgName?: string;
  industry?: string;
  teammateCount?: number;
  members?: Array<{ uid: string; role: string; displayName: string; email: string; status: string }>;
  starterTemplate?: { key: string; label: string; requiredProofCount: number; acceptanceCheckCount: number } | null;
  hasIncidents?: boolean;
}

function dismissKey(orgId: string) {
  return `peakops.welcome.dismissed.${orgId}`;
}

export function WelcomeFirstRun({ orgId }: Props) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Read dismiss flag once on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(dismissKey(orgId)) === "1") {
        setDismissed(true);
      }
    } catch {}
  }, [orgId]);

  // Fetch onboarding status. Single one-shot read — no polling, no
  // refetch on focus. The card is intentionally cheap.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/onboarding-status?orgId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const j = await res.json().catch(() => null);
        if (!cancelled && j && j.ok) setStatus(j);
      } catch {
        // Silent — welcome card is non-essential; never blocks dashboard.
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  function handleDismiss() {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(dismissKey(orgId), "1"); } catch {}
    setDismissed(true);
  }

  if (dismissed) return null;
  if (!status || !status.ok) return null;
  if (status.hasIncidents) return null;

  const orgName = status.orgName || orgId;
  const template = status.starterTemplate;
  const teammates = status.teammateCount || 0;
  const owners = (status.members || []).filter((m) => m.role === "owner");
  const otherMembers = (status.members || []).filter((m) => m.role !== "owner");

  // Each chip carries the same shape: glyph + headline + one-line detail.
  // No nested CTAs — keeps the surface scan-friendly.
  return (
    <section
      data-testid="welcome-first-run"
      data-org-id={orgId}
      className="mb-6 rounded-2xl border border-emerald-400/25 bg-gradient-to-b from-emerald-500/[0.06] to-white/[0.02] p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-white">
            Welcome to PeakOps, {orgName}
          </h2>
          <p className="text-[12px] text-gray-400 mt-1 leading-relaxed">
            Your account is active. Here&apos;s what&apos;s already set up — and what to do first.
          </p>
        </div>
        <button
          type="button"
          data-testid="welcome-first-run-dismiss"
          onClick={handleDismiss}
          className="text-[11px] uppercase tracking-[0.16em] text-gray-500 hover:text-white transition px-2 py-1 rounded"
          aria-label="Dismiss welcome card"
        >
          Got it
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
        <Chip
          tone="ok"
          glyph="✓"
          headline="Activation complete"
          detail={`Org "${orgName}" is active.`}
          dataTest="welcome-chip-activation"
        />
        <Chip
          tone={template ? "ok" : "missing"}
          glyph={template ? "✓" : "—"}
          headline={template ? "Starter template ready" : "No starter template yet"}
          detail={
            template
              ? `${template.label} · ${template.requiredProofCount} required-proof · ${template.acceptanceCheckCount} acceptance checks`
              : "Configure a template under Settings → Templates before your first record."
          }
          dataTest="welcome-chip-template"
        />
        <Chip
          tone={teammates > 0 ? "ok" : "warn"}
          glyph={teammates > 0 ? "✓" : "○"}
          headline={
            teammates > 0
              ? `${teammates} ${teammates === 1 ? "teammate" : "teammates"} invited`
              : "No teammates invited yet"
          }
          detail={
            teammates > 0
              ? `Roles: ${summarizeRoles(otherMembers)}.`
              : "Invite supervisors and field techs from Settings → Team."
          }
          dataTest="welcome-chip-team"
        />
      </div>

      {/* Teammates roster (only when there are invitees beyond owner) */}
      {otherMembers.length > 0 && (
        <div data-testid="welcome-roster" className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500 mb-2">Team</div>
          <ul className="space-y-1">
            {owners.map((m) => (
              <li key={m.uid} className="text-[12px] text-gray-300 flex items-center gap-2 flex-wrap">
                <span className="font-medium text-white">{m.displayName || m.email || "Owner"}</span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-emerald-300/90">owner</span>
                <span className="text-gray-500">— you</span>
              </li>
            ))}
            {otherMembers.map((m) => (
              <li key={m.uid} className="text-[12px] text-gray-300 flex items-center gap-2 flex-wrap">
                <span className="font-medium text-white">{m.displayName || m.email || m.uid.slice(0, 8)}</span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-gray-400">{m.role}</span>
                <span className="text-gray-500">— invite sent</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-gray-500 mt-2 italic">
            Teammates receive a magic-link email separately. They&apos;ll appear active here once they sign in for the first time.
          </p>
        </div>
      )}

      {/* Next-step CTA. One destination — no decision paralysis. */}
      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <p className="text-[12px] text-gray-300">
          Next: open a field record so your first incident appears here.
        </p>
        <a
          href={`/incidents/new?orgId=${encodeURIComponent(orgId)}`}
          data-testid="welcome-next-cta"
          className="px-4 py-2 rounded-full text-[12px] font-semibold text-black bg-white hover:bg-white/90 transition"
        >
          Create your first field record →
        </a>
      </div>
    </section>
  );
}

function Chip({
  tone,
  glyph,
  headline,
  detail,
  dataTest,
}: {
  tone: "ok" | "warn" | "missing";
  glyph: string;
  headline: string;
  detail: string;
  dataTest?: string;
}) {
  const wrap =
    tone === "ok"
      ? "border-emerald-400/30 bg-emerald-500/[0.05]"
      : tone === "warn"
      ? "border-amber-400/30 bg-amber-500/[0.05]"
      : "border-white/15 bg-white/[0.03]";
  const glyphTone =
    tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-gray-500";
  return (
    <div data-testid={dataTest} className={`rounded-lg border ${wrap} px-3 py-2.5`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={`text-[12px] font-bold ${glyphTone}`}>{glyph}</span>
        <span className="text-[12px] font-medium text-white">{headline}</span>
      </div>
      <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{detail}</p>
    </div>
  );
}

function summarizeRoles(members: Array<{ role: string }>): string {
  const counts: Record<string, number> = {};
  for (const m of members) {
    const r = m.role || "member";
    counts[r] = (counts[r] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`)
    .join(", ");
}
