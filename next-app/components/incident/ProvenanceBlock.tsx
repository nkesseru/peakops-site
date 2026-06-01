"use client";

// PEAKOPS_TEMPLATE_PROVENANCE_V1 (PR 120b)
//
// Renders "Requirements source: <Customer> · <Archetype> · v<N>" with
// an audit framing line. Used by:
//   - SummaryClient (above the proof-slot dossier, PR 117)
//   - AddEvidenceClient (above the required-proof checklist)
//
// Visual treatment: simple, boring, operator-focused. Single header
// + one bold customer-language line + (when version > 1) one calm
// audit line explaining snapshot immutability. Hides entirely on
// archetype fallback or pre-PR-91 snapshots (no templateKey).
//
// Customer label resolution per PR #120 decision #8:
//   1. requirements.customerLabel (PR 120a snapshot field)
//   2. parse from requirements.templateKey slug:
//      "fiber_splice_verification__comcast-restoration" → "Comcast Restoration"
//   3. omit the customer fragment entirely (org_template / no slug)

import { ARCHETYPE_LABELS, type Archetype } from "@/lib/incidents/newIncidentDraft";

export type Provenance = {
  source?: string | null;
  templateKey?: string | null;
  templateVersion?: number | null;
  customerLabel?: string | null;
  archetype?: string | null;
  snapshottedAt?: string | null;
};

export function deriveCustomerLabel(p: Provenance): string {
  const explicit = String(p.customerLabel || "").trim();
  if (explicit) return explicit;
  // Slug-parse fallback for pre-PR-120 snapshots that carry templateKey
  // but not customerLabel. templateKey shape from createIncidentV1:
  // "${archetype}__${customerSlug}". The slug uses lowercased
  // hyphen-separated words per _customerSlug.js — we title-case each
  // word for display. Hyphens within words ("at-t") are preserved.
  const key = String(p.templateKey || "").trim();
  if (!key) return "";
  const parts = key.split("__");
  if (parts.length < 2) return "";        // org-wide template; no customer
  const slug = parts.slice(1).join("__"); // defensive against extra "__"
  if (!slug) return "";
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export function ProvenanceBlock({
  provenance,
  variant = "default",
}: {
  provenance: Provenance;
  // "default" — Summary (block-styled, two lines)
  // "compact" — AddEvidence above checklist (single line, lighter)
  variant?: "default" | "compact";
}) {
  // Hide entirely when no template provenance is available — archetype
  // fallback or pre-PR-91 records. We never inflate a record with
  // synthetic provenance.
  const source = String(provenance.source || "").trim().toLowerCase();
  const templateKey = String(provenance.templateKey || "").trim();
  const isFromTemplate = source === "customer_template" || source === "org_template";
  if (!isFromTemplate || !templateKey) return null;

  const customerLabel = deriveCustomerLabel(provenance);
  const archetypeKey = String(provenance.archetype || "").trim();
  const archetypeLabel = ARCHETYPE_LABELS[archetypeKey as Archetype] || archetypeKey;
  const version = Number(provenance.templateVersion);
  const versionStr = Number.isFinite(version) && version > 0 ? `v${version}` : "";

  // Compose the bold line — drop empty fragments so org-wide templates
  // (no customerLabel) render cleanly as "<Archetype> · v3".
  const fragments = [customerLabel, archetypeLabel, versionStr].filter((s) => s.length > 0);
  const line = fragments.join(" · ");

  // PR 120 decision #6 — hide the audit line on v1 only. "Edits since"
  // framing is misleading when no edits exist.
  const showAuditLine = Number.isFinite(version) && version > 1;

  if (variant === "compact") {
    return (
      <div className="text-[11px] text-gray-400">
        <span className="text-gray-500">Requirements source · </span>
        <span className="text-gray-200">{line}</span>
      </div>
    );
  }

  return (
    <section
      aria-label="Requirements source"
      className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 space-y-1"
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
        Requirements source
      </div>
      <div className="text-[13px] text-gray-100 font-medium leading-tight">
        {line}
      </div>
      {showAuditLine ? (
        <div className="text-[11px] text-gray-500 leading-relaxed">
          Captured at incident creation. Template edits since don&apos;t apply
          to this record.
        </div>
      ) : null}
    </section>
  );
}
