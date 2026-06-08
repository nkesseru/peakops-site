// PEAKOPS_RECOVERY_TEMPLATE_OPPORTUNITY_V1 (PR 132c-b)
//
// "Revenue Protection Opportunity" strip rendered directly under the
// Template Editor header. Surfaces template_gap aggregate data
// (PR 132c-a backend) to admins editing a template, with action-
// oriented recommendations mapped per top cause.
//
// Architecture lock (PR 132c planning, locked 2026-06-08):
//   - Title: "Revenue Protection Opportunity" (decision lock #6)
//   - Threshold: render only when rejections >= 3 in the 30-day window
//   - Window locked to 30 days (no selector)
//   - Always expanded; no collapsed state
//   - All tied top causes shown (no arbitrary pick)
//   - Inline strip below template header — no side panel, no
//     standalone dashboard
//
// Wedge guards:
//   - Renders nothing when rejections < 3 (silence > noise)
//   - Recommendation copy only shown for causes the admin can fix
//     with a template change. Non-fixable top causes still show
//     counts; no recommendation text gets fabricated.
//   - No analytics tracking, no notifications, no AI claims
//   - "unknown" cause excluded from top-cause derivation (it tells
//     the admin nothing actionable)

"use client";

import { useEffect, useMemo, useState } from "react";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import {
  TEMPLATE_GAP_RECOMMENDATIONS,
  CAUSE_DISPLAY_LOCAL,
  deriveTopCauses,
  fixableTopCauses,
  type TemplateGapMetrics,
  type TemplateGapSummary,
} from "@/lib/recovery/templateGap.types";

const RENDER_THRESHOLD = 3;
const WINDOW_DAYS = 30;

type Props = {
  orgId: string;
  templateKey: string;
};

export function RevenueProtectionOpportunityStrip({ orgId, templateKey }: Props) {
  const { user } = useAuth();
  const actorUid = String(user?.uid || "").trim();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [metrics, setMetrics] = useState<TemplateGapMetrics | null>(null);

  useEffect(() => {
    if (!orgId || !templateKey || !actorUid) return;
    let cancelled = false;
    setLoading(true);
    setErr("");
    (async () => {
      try {
        const url =
          `/api/fn/getRecoveryAggregatesV1` +
          `?orgId=${encodeURIComponent(orgId)}` +
          `&type=template_gap` +
          `&windowDays=${WINDOW_DAYS}` +
          `&templateKey=${encodeURIComponent(templateKey)}` +
          `&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: TemplateGapSummary = await res.json().catch(() => ({ ok: false }));
        if (cancelled) return;
        if (!res.ok || !out.ok) {
          setErr(out.error || `HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        setMetrics(out.summary?.metrics || null);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Failed to load");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, templateKey, actorUid]);

  const rejections = Number(metrics?.rejections) || 0;

  // Hidden silently when below threshold OR when something failed
  // OR while loading. The strip should never be a half-rendered tease.
  const shouldRender = !loading && !err && rejections >= RENDER_THRESHOLD;

  // Derive top causes (excluding "unknown") and split into
  // recommendable vs. non-fixable.
  const { topCauses, fixable } = useMemo(() => {
    const top = deriveTopCauses(metrics?.causeMix);
    const fix = fixableTopCauses(top);
    return { topCauses: top, fixable: fix };
  }, [metrics?.causeMix]);

  if (!shouldRender) return null;

  const causeMix = metrics?.causeMix || {};
  const versionMix = metrics?.versionMix || {};

  return (
    <section
      aria-label="Revenue Protection Opportunity"
      className="rounded-xl border-2 border-amber-400/40 bg-amber-500/[0.07] px-5 py-4 sm:px-6 sm:py-5 space-y-4"
    >
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0 leading-none" aria-hidden>⚠</span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200">
            Revenue Protection Opportunity
          </div>
          <div className="text-sm sm:text-base text-amber-50/95 leading-snug">
            This template caused {rejections} customer rejection{rejections === 1 ? "" : "s"} in
            the last {WINDOW_DAYS} days.
          </div>
        </div>
      </div>

      {/* Top-cause headline + recommendation block. Only renders when at
          least one top cause has a recommendation. Tied fixable causes
          stack as bullet points. Non-fixable top causes are intentionally
          omitted from this block (counts still show below). */}
      {fixable.length > 0 && (
        <div className="space-y-3 pt-1 border-t border-amber-400/20">
          {fixable.map((cause) => {
            const entry = TEMPLATE_GAP_RECOMMENDATIONS[cause];
            return (
              <div key={cause} className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-200/85">
                  {fixable.length > 1 ? "One of the top reasons:" : "Top reason:"}{" "}
                  <span className="normal-case text-amber-100/90 font-normal">
                    {CAUSE_DISPLAY_LOCAL[cause] || cause}
                  </span>
                </div>
                <div className="text-[13px] text-amber-50/90 leading-relaxed">
                  {entry.headline}
                </div>
                <div className="text-[13px] text-white leading-relaxed">
                  <span className="font-semibold text-amber-200">Recommended action:</span>{" "}
                  {entry.recommendation}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* When top causes exist but none are template-fixable, surface a
          short explanatory line so admins know the count isn't being
          ignored. */}
      {fixable.length === 0 && topCauses.length > 0 && (
        <div className="text-[12px] text-amber-100/75 italic leading-relaxed pt-1 border-t border-amber-400/20">
          The top reason{topCauses.length > 1 ? "s" : ""} for these rejections
          {topCauses.length > 1 ? " aren't" : " isn't"} typically fixed by template changes.
          Review individual cases for context.
        </div>
      )}

      {/* Cause mix — counts only, ordered by frequency desc */}
      <div className="space-y-1.5 pt-2 border-t border-amber-400/20">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-200/70">
          Cause mix (last {WINDOW_DAYS} days)
        </div>
        <ul className="space-y-0.5">
          {Object.entries(causeMix)
            .map(([k, v]) => [k, Number(v)] as [string, number])
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([cause, count]) => (
              <li key={cause} className="flex items-baseline gap-3 text-[12px] text-amber-50/85">
                <span className="flex-1 truncate">{CAUSE_DISPLAY_LOCAL[cause] || cause}</span>
                <span className="tabular-nums text-amber-100 font-semibold">{count}</span>
              </li>
            ))}
        </ul>
      </div>

      {/* Version mix — shows whether the current version is clean */}
      {Object.keys(versionMix).length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-amber-400/20">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-200/70">
            Rejections by version
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-amber-50/90">
            {Object.entries(versionMix)
              .map(([k, v]) => [k, Number(v)] as [string, number])
              .filter(([, v]) => v > 0)
              .sort((a, b) => {
                // Sort by version number ascending where possible; fall
                // back to alpha sort for "vUnknown" / non-numeric keys.
                const an = Number(String(a[0]).replace(/^v/, ""));
                const bn = Number(String(b[0]).replace(/^v/, ""));
                if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
                return String(a[0]).localeCompare(String(b[0]));
              })
              .map(([versionKey, count]) => (
                <span key={versionKey} className="whitespace-nowrap">
                  <span className="text-amber-200/80">{versionKey}:</span>{" "}
                  <span className="tabular-nums font-semibold">{count}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      <div className="text-[11px] text-amber-100/60 italic leading-relaxed pt-1">
        These counts come from customer rejections recovered through this template.
        Each fix here is a permanent process improvement — fewer rejections going forward.
      </div>
    </section>
  );
}
