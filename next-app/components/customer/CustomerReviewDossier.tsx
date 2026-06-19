// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// Pure render component for the customer-facing dossier. No actions,
// no fetches — takes the data and renders it. Mobile-first single
// column. Light theme on purpose: the customer is a guest, not staff,
// and a lighter palette signals that. Operator UIs remain dark.
//
// What this component intentionally does NOT show:
//   - archetypeSource (operator-side audit only)
//   - tokenHashPrefix, internal uids, IP / UA fingerprints
//   - any actions (Accept/Reject live in the parent client)
//
// What it does show:
//   - Provenance the customer needs to recognize the packet
//   - Required proof + reasons (PR 120b / 126a contract)
//   - Optional proof + acceptance criteria
//   - Acceptance checks
//   - Readiness state (derived in PR 126e)
//   - Evidence list (metadata only — thumbnails are Phase 1)

import type { CustomerReviewDossierData, CustomerReviewPacket } from "@/lib/customerReview/types";
import { REQUIREMENTS_SOURCE_DISPLAY } from "@/lib/customerReview/types";

type Props = {
  data: CustomerReviewDossierData;
  // PEAKOPS_REVIEW_VERSION_PIN_V2 (2026-06-15)
  // Optional pinned/current/isLatest block. Null for pre-slice-1
  // links — in that case, no version-stamp box and no drift banner.
  packet?: CustomerReviewPacket | null;
};

function fmtIso(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function CustomerReviewDossier({ data, packet }: Props) {
  const archetypeDisplay = data.archetype
    ? data.archetype.split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")
    : "";

  // PEAKOPS_REVIEW_VERSION_PIN_V2 (2026-06-15) — drift banner data
  const pinned = packet?.pinned || null;
  const current = packet?.current || null;
  const showDriftBanner = !!(
    pinned && current && packet?.isLatest === false
  );

  return (
    <div className="space-y-6 text-gray-800">
      {/* PEAKOPS_REVIEW_VERSION_PIN_V2 — calm drift banner. Renders
          only when the link's pinned version is older than the
          incident's current packet version. Informational, not
          blocking — the customer can still accept. Wording is the
          audit anchor: explicit version numbers + "applies only to
          vN" so a reviewer can read the receipt later and know
          exactly what the customer agreed to. */}
      {showDriftBanner && (
        <div
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 space-y-1"
          role="status"
        >
          <div className="font-semibold flex items-center gap-2">
            <span aria-hidden>⚠</span>
            <span>A newer packet exists.</span>
          </div>
          <p className="leading-relaxed">
            You are reviewing packet <span className="font-mono">v{pinned!.version}</span>
            {pinned!.generatedAt ? <> (generated {fmtIso(pinned!.generatedAt)})</> : null}.
            The team has since generated <span className="font-mono">v{current!.version}</span>.
            Contact your project team if you would like to review the latest
            before deciding. Acceptance below applies only to v{pinned!.version}.
          </p>
        </div>
      )}

      {/* PEAKOPS_REVIEW_VERSION_PIN_V2 — version stamp. Renders
          whenever the link is version-pinned (slice 1 onward). Pre-
          slice-1 links carry no `pinned` and skip this entirely. */}
      {pinned && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
          <div>
            <span className="text-gray-500">Reviewing packet</span>{" "}
            <span className="font-mono font-semibold">v{pinned.version}</span>
            {pinned.generatedAt && (
              <>
                {" · "}
                <span className="text-gray-500">generated</span>{" "}
                <span className="font-mono">{fmtIso(pinned.generatedAt)}</span>
              </>
            )}
          </div>
          {pinned.hashPrefix && (
            <div className="text-gray-500 mt-0.5">
              Content hash: <span className="font-mono">{pinned.hashPrefix}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Header / provenance ──────────────────────────────── */}
      <header className="space-y-2 pb-4 border-b border-gray-200">
        {data.title && (
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-gray-900 leading-tight">
            {data.title}
          </h1>
        )}
        <div className="text-sm text-gray-600 space-y-0.5">
          {data.customerLabel && (
            <div>
              <span className="text-gray-500">Customer:</span> <span className="font-medium text-gray-800">{data.customerLabel}</span>
            </div>
          )}
          {archetypeDisplay && (
            <div>
              <span className="text-gray-500">Type:</span> <span className="text-gray-800">{archetypeDisplay}</span>
              {data.templateVersion != null && (
                <span className="text-gray-500"> · v{data.templateVersion}</span>
              )}
            </div>
          )}
          {data.location && (
            <div>
              <span className="text-gray-500">Location:</span> <span className="text-gray-800">{data.location}</span>
            </div>
          )}
        </div>

        {/* Sent-by attribution + audit footer */}
        <div className="text-xs text-gray-500 pt-2 space-y-0.5">
          {data.coordinatorDisplayName && (
            <div>Sent by {data.coordinatorDisplayName}</div>
          )}
          {data.submittedToCustomerAt && (
            <div>Sent {fmtIso(data.submittedToCustomerAt)}</div>
          )}
          <div className="text-[11px] text-gray-400 pt-0.5">
            Source: {REQUIREMENTS_SOURCE_DISPLAY[data.requirementsSource]}
          </div>
        </div>
      </header>

      {/* ── Summary ─────────────────────────────────────────── */}
      {data.summary && (
        <section className="space-y-1.5">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Summary
          </h2>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
            {data.summary}
          </p>
        </section>
      )}

      {/* ── Required proof ──────────────────────────────────── */}
      {data.requirements.requiredProof.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Required proof
          </h2>
          <ul className="space-y-2.5">
            {data.requirements.requiredProof.map((item, i) => {
              const slotCheck = data.readiness.checks.find(
                (c) => c.tier === "required" && c.label === item.label
              );
              const satisfied = slotCheck?.satisfied === true;
              return (
                <li key={i} className="flex items-start gap-2.5">
                  <span
                    className={
                      "mt-0.5 flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold " +
                      (satisfied
                        ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                        : "bg-gray-100 text-gray-400 border border-gray-300")
                    }
                    aria-label={satisfied ? "Satisfied" : "Not yet"}
                  >
                    {satisfied ? "✓" : ""}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800 font-medium">{item.label}</div>
                    {item.description && (
                      <div className="text-xs text-gray-600 mt-0.5">
                        <span className="text-gray-500">Reason:</span> {item.description}
                      </div>
                    )}
                    {slotCheck?.detail && (
                      <div className="text-[11px] text-gray-500 mt-0.5">{slotCheck.detail}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── Optional proof ──────────────────────────────────── */}
      {data.requirements.optionalProof.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Optional proof
          </h2>
          <ul className="text-sm text-gray-700 space-y-1 pl-4 list-disc">
            {data.requirements.optionalProof.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Acceptance criteria (prose) ─────────────────────── */}
      {data.requirements.acceptanceCriteria.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Acceptance criteria
          </h2>
          <ul className="text-sm text-gray-700 space-y-1 pl-4 list-disc">
            {data.requirements.acceptanceCriteria.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Acceptance checks (deterministic) ───────────────── */}
      {data.acceptanceChecks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Acceptance checks
          </h2>
          <ul className="space-y-2">
            {data.acceptanceChecks.map((check, i) => {
              const matchingReadinessCheck = data.readiness.checks.find(
                (c) => c.tier === check.tier && (c.label === check.label || c.key === check.type)
              );
              const satisfied = matchingReadinessCheck?.satisfied === true;
              const isRequired = check.tier === "required";
              return (
                <li key={i} className="flex items-start gap-2.5">
                  <span
                    className={
                      "mt-0.5 flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold " +
                      (satisfied
                        ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                        : "bg-gray-100 text-gray-400 border border-gray-300")
                    }
                  >
                    {satisfied ? "✓" : ""}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800">
                      {check.label || check.type}
                      {!isRequired && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-500">encouraged</span>
                      )}
                    </div>
                    {check.description && (
                      <div className="text-xs text-gray-600 mt-0.5">{check.description}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── Evidence (metadata only in MVP) ─────────────────── */}
      {data.evidenceItems.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Evidence ({data.evidenceItems.length} {data.evidenceItems.length === 1 ? "item" : "items"})
          </h2>
          <ul className="space-y-2">
            {data.evidenceItems.map((ev) => (
              <li
                key={ev.id}
                className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5"
              >
                <div className="text-sm font-medium text-gray-800 break-all">{ev.filename}</div>
                {ev.caption && (
                  <div className="text-xs text-gray-600 mt-0.5">{ev.caption}</div>
                )}
                {(ev.slotKey || ev.capturedAt) && (
                  <div className="text-[11px] text-gray-500 mt-1 space-x-2">
                    {ev.slotKey && <span>Slot: {ev.slotKey}</span>}
                    {ev.capturedAt && <span>Captured {fmtIso(ev.capturedAt)}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Readiness summary ───────────────────────────────── */}
      <section
        className={
          "rounded-lg border px-3.5 py-3 " +
          (data.readiness.ready
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50")
        }
      >
        <div className="flex items-center gap-2">
          <span className={"text-lg leading-none " + (data.readiness.ready ? "text-emerald-600" : "text-amber-600")}>
            {data.readiness.ready ? "✓" : "⌛"}
          </span>
          <div className="text-sm font-semibold text-gray-800">
            {data.readiness.ready ? "Ready for your review" : data.readiness.label}
          </div>
        </div>
        {!data.readiness.ready && data.readiness.checks.length > 0 && (
          <div className="text-xs text-gray-600 mt-1.5">
            Some required items are not yet captured. You may still review and provide feedback.
          </div>
        )}
      </section>
    </div>
  );
}
