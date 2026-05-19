"use client";

/**
 * PEAKOPS_SEALED_RECORD_PANEL_V1 (2026-05-18, PR 42)
 *
 * Shared UI for the closed-record contract: when an incident has
 * status="closed", mutation surfaces (AddEvidence upload, JobDetail
 * upload, Notes editor) replace their normal CTAs with this panel.
 * Three variants share the same component to keep tone consistent
 * across surfaces.
 *
 * Constraints honored:
 *   - calm operational tone (no "ACCESS DENIED" energy)
 *   - amber border, gray-100 body, no red
 *   - Addendum CTA is intentionally non-functional in this PR (PR 43
 *     wires the real addendum flow). Shows an inline acknowledgment
 *     message on click.
 *   - Optional recovery action for the mid-edit 409 case (e.g., "Copy
 *     unsaved notes"). Renders next to the addendum CTA when present.
 */

import { useRouter } from "next/navigation";

export type SealedVariant = "fullPage" | "inlineBanner" | "notesBanner";

export type RecoveryAction = {
  label: string;
  onClick: () => void;
};

export type SealedRecordPanelProps = {
  variant: SealedVariant;
  title: string;
  body: string;
  orgId: string;
  incidentId: string;
  showBackToSummary?: boolean;
  recovery?: RecoveryAction;
};

export function SealedRecordPanel({
  variant,
  title,
  body,
  orgId,
  incidentId,
  showBackToSummary = true,
  recovery,
}: SealedRecordPanelProps) {
  const router = useRouter();

  function handleCreateAddendum() {
    // PEAKOPS_ADDENDUM_NAV_V1 (2026-05-19, PR 43)
    // PR 42 had a 4s "coming soon" placeholder. PR 43 ships the real
    // addendum flow at /incidents/{id}/add-addendum?orgId=...
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    router.push(`/incidents/${encodeURIComponent(incidentId)}/add-addendum${qs}`);
  }

  function handleBackToSummary() {
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    router.push(`/incidents/${encodeURIComponent(incidentId)}/summary${qs}`);
  }

  const eyebrowClass =
    "text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70";
  const titleClass =
    variant === "fullPage"
      ? "text-2xl font-semibold leading-tight tracking-tight text-white"
      : "text-[14px] font-medium text-amber-100";
  const bodyClass =
    variant === "fullPage"
      ? "text-[14px] text-gray-300 leading-relaxed max-w-prose"
      : "text-[12px] text-gray-300 leading-relaxed";

  const buttonsClass = "flex items-center gap-3 flex-wrap pt-1";
  const primaryButtonClass =
    "px-4 py-2 rounded-lg text-[13px] font-medium border border-amber-300/30 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 transition";
  const secondaryButtonClass =
    "px-4 py-2 rounded-lg text-[13px] font-medium border border-white/10 bg-white/[0.03] text-gray-300 hover:bg-white/[0.06] transition";
  const recoveryButtonClass =
    "px-4 py-2 rounded-lg text-[13px] font-medium border border-white/10 bg-white/[0.03] text-gray-300 hover:bg-white/[0.06] transition";

  const content = (
    <div className="space-y-3">
      <div className={eyebrowClass}>Sealed operational record</div>
      <div className={titleClass}>{title}</div>
      <div className={bodyClass}>{body}</div>
      <div className={buttonsClass}>
        <button
          type="button"
          className={primaryButtonClass}
          onClick={handleCreateAddendum}
        >
          Create addendum
        </button>
        {recovery ? (
          <button
            type="button"
            className={recoveryButtonClass}
            onClick={recovery.onClick}
          >
            {recovery.label}
          </button>
        ) : null}
        {showBackToSummary ? (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={handleBackToSummary}
          >
            ← Back to summary
          </button>
        ) : null}
      </div>
    </div>
  );

  // Full-page variant — centered on its own main, used by AddEvidence
  // when the entire upload flow is suppressed.
  if (variant === "fullPage") {
    return (
      <main className="min-h-screen bg-black text-white py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="rounded-2xl border border-amber-300/20 bg-amber-500/[0.05] p-6 sm:p-8">
            {content}
          </div>
        </div>
      </main>
    );
  }

  // Inline / notes banner — compact panel that fits inside the host
  // component's existing layout.
  return (
    <div className="rounded-xl border border-amber-300/20 bg-amber-500/[0.05] p-4">
      {content}
    </div>
  );
}
