/**
 * PEAKOPS_ACCEPTANCE_READINESS_PANEL_V1 (PR 103b)
 *
 * Summary-page panel showing the deterministic acceptance-readiness
 * projection backed by getAcceptanceReadinessV1 (PR 103a) + per-
 * customer-template checks (PR 104).
 *
 * Renders three sections:
 *   1. Header strip — state pill + counts (no percentages)
 *   2. Required checklist — ✓ / ✗ per check, missing items first
 *      when state is requirements_missing
 *   3. Encouraged checklist — when present, rendered below required
 *   4. Unknown checks — neutral ⚠ rows; never block state
 *   5. Customer acceptance criteria prose — informational, when
 *      provided by the snapshot
 *
 * No percentages. No probability language. No AI scoring. Loading
 * state is a muted single line; fetch failure hides the panel
 * entirely (don't surface infra noise on the workflow surface).
 */

"use client";

import { ReadinessPill } from "@/components/ReadinessPill";
import type {
  AcceptanceReadiness,
  ReadinessCheck,
  ReadinessSatisfaction,
} from "@/lib/incidents/acceptanceReadinessTypes";

/**
 * Three render states the panel handles. Parents that fetch their
 * own data pass the result here; the panel doesn't decide WHEN to
 * fetch, only HOW to render. Hides itself on `"error"`.
 */
export type PanelData =
  | { kind: "loading" }
  | { kind: "ok"; readiness: AcceptanceReadiness }
  | { kind: "error" };

type PanelProps = {
  data: PanelData;
  /** Snapshotted prose; rendered as informational bullet list. */
  acceptanceCriteria?: string[] | null;
};

function tickFor(s: ReadinessSatisfaction): { glyph: string; toneClass: string; ariaLabel: string } {
  if (s === true) return { glyph: "✓", toneClass: "text-emerald-300", ariaLabel: "satisfied" };
  if (s === false) return { glyph: "✗", toneClass: "text-amber-200", ariaLabel: "missing" };
  return { glyph: "⚠", toneClass: "text-gray-300", ariaLabel: "unknown" };
}

function CheckRow({ c }: { c: ReadinessCheck }) {
  const t = tickFor(c.satisfied);
  // PR 120b — customer-authored rationale rendered as a "Reason:"
  // line below the check's detail. Persisted on the snapshot per
  // PR 118 (template_check) + PR 120a (required_proof). When absent,
  // the row renders today's visual unchanged.
  const reason = String(c.description || "").trim();
  return (
    <li className="flex items-start gap-3 text-[13px] leading-relaxed py-0.5">
      <span aria-hidden="true" className={`mt-[2px] inline-block w-3 text-center font-semibold ${t.toneClass}`}>
        {t.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-gray-100">{c.label}</div>
        {c.detail ? (
          <div className="text-[11px] text-gray-400 mt-0.5">{c.detail}</div>
        ) : null}
        {reason ? (
          <div className="text-[11px] text-gray-400 mt-0.5">
            <span className="text-gray-500">Reason: </span>
            {reason}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function AcceptanceReadinessPanel({
  data,
  acceptanceCriteria,
}: PanelProps) {
  // Fetch failure — hide the panel entirely. Don't burden the
  // operator's workflow surface with infra noise.
  if (data.kind === "error") return null;

  // Loading — single muted line so the slot doesn't pop in/out.
  if (data.kind === "loading") {
    return (
      <section aria-label="Acceptance readiness" className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
          Acceptance Readiness
        </div>
        <div className="text-[12px] text-gray-400">Computing acceptance readiness…</div>
      </section>
    );
  }

  const r = data.readiness;
  const requiredChecks = r.checks.filter((c) => c.tier === "required");
  const encouragedChecks = r.checks.filter((c) => c.tier === "encouraged");
  const unknownChecks = r.checks.filter((c) => c.satisfied === "unknown");
  // For the required list: when state is missing, show missing rows
  // first; otherwise render in declared order.
  const requiredKnown = requiredChecks.filter((c) => c.satisfied === true || c.satisfied === false);
  const requiredMissingFirst =
    r.state === "requirements_missing"
      ? [
          ...requiredKnown.filter((c) => c.satisfied === false),
          ...requiredKnown.filter((c) => c.satisfied === true),
        ]
      : requiredKnown;

  const countLine = (() => {
    const parts = [
      `${r.summary.requiredSatisfied} / ${r.summary.requiredTotal} required`,
    ];
    if (r.summary.encouragedTotal > 0) {
      parts.push(`${r.summary.encouragedSatisfied} / ${r.summary.encouragedTotal} encouraged`);
    }
    if ((r.summary.requiredUnknown || 0) + (r.summary.encouragedUnknown || 0) > 0) {
      parts.push(`${(r.summary.requiredUnknown || 0) + (r.summary.encouragedUnknown || 0)} unknown`);
    }
    return parts.join(" · ");
  })();

  const criteriaList = Array.isArray(acceptanceCriteria)
    ? acceptanceCriteria.map((s) => String(s || "").trim()).filter((s) => s.length > 0)
    : [];

  return (
    <section aria-label="Acceptance readiness" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
          Acceptance Readiness
        </div>
        <ReadinessPill state={r.state} />
      </div>
      <div className="text-[11px] text-gray-500">{countLine}</div>

      {r.state === "not_available" ? (
        <div className="text-[12px] text-gray-400">
          Readiness could not be evaluated for this record. No required-proof
          snapshot or evidence exists yet.
        </div>
      ) : (
        <>
          {requiredMissingFirst.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500">
                Required
              </div>
              <ul className="space-y-0.5">
                {requiredMissingFirst.map((c) => (
                  <CheckRow key={c.key} c={c} />
                ))}
              </ul>
            </div>
          ) : null}

          {encouragedChecks.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500">
                Encouraged
              </div>
              <ul className="space-y-0.5">
                {encouragedChecks
                  .filter((c) => c.satisfied === true || c.satisfied === false)
                  .map((c) => (
                    <CheckRow key={c.key} c={c} />
                  ))}
              </ul>
            </div>
          ) : null}

          {unknownChecks.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500">
                Unknown
              </div>
              <ul className="space-y-0.5">
                {unknownChecks.map((c) => (
                  <CheckRow key={c.key} c={c} />
                ))}
              </ul>
              <div className="text-[11px] text-gray-500 mt-1">
                These check types weren’t recognized by the current backend. They
                don’t block readiness.
              </div>
            </div>
          ) : null}
        </>
      )}

      {/* PR 104 — Customer Acceptance Criteria prose. Informational
          only, never machine-evaluated. Rendered as a calm bulleted
          list when present. */}
      {criteriaList.length > 0 ? (
        <div className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-500">
            Customer Acceptance Criteria
          </div>
          <div className="text-[10px] text-gray-500 italic">
            Stated by the customer template — not machine-evaluated.
          </div>
          <ul className="list-disc pl-5 text-[12px] text-gray-200 space-y-0.5 mt-1">
            {criteriaList.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * SummaryClient (or any parent) drives the single fetch and passes
 * `data` down. This avoids duplicate requests when multiple
 * components on the same page need the readiness state.
 *
 * Recommended parent pattern:
 *   const [data, setData] = useState<PanelData>({ kind: "loading" });
 *   useEffect(() => { ...fetch + setData... }, [orgId, incidentId, refetchTick]);
 *   <AcceptanceReadinessPanel data={data} acceptanceCriteria={...} />
 *   {data.kind === "ok" && data.readiness.state === "requirements_missing"
 *     ? <ExportWarning /> : null}
 */
