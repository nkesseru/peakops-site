// PR 133B — Operator-facing compliance findings panel.
//
// Renders the unified status chip + per-finding rows for an incident's
// persisted complianceReadiness (populated server-side by
// _readiness.js when the org's validation.mode is "passive_persist"
// or "block"). Falls back to chip-only / acceptance-only when
// complianceReadiness is absent — the UI never goes blank.

"use client";

import type { ComplianceReadiness, AcceptanceReadinessState } from "@/lib/compliance/types";
import {
  deriveChipState,
  explainCode,
  severityCopy,
  sortIssuesBySeverity,
} from "@/lib/compliance/complianceCopy";

interface Props {
  compliance: ComplianceReadiness | null | undefined;
  acceptanceState?: AcceptanceReadinessState | null;
  className?: string;
}

const CHIP_STYLE: Record<string, string> = {
  ready: "bg-emerald-500/15 border-emerald-400/40 text-emerald-200",
  warning: "bg-amber-500/15 border-amber-400/40 text-amber-200",
  blocking: "bg-red-500/15 border-red-400/45 text-red-200",
  unknown: "bg-white/[0.04] border-white/15 text-gray-400",
};

const SEVERITY_BAR: Record<string, string> = {
  red: "bg-red-400/80",
  amber: "bg-amber-400/80",
  blue: "bg-sky-400/80",
};

export function ComplianceFindingsPanel({ compliance, acceptanceState, className }: Props) {
  const chip = deriveChipState(compliance ?? null, acceptanceState ?? null);
  const issues = sortIssuesBySeverity(compliance?.issues || []);
  const rulepackVersions = compliance?.rulepackVersionsByType || {};

  return (
    <div
      data-testid="compliance-findings-panel"
      data-chip-state={chip.state}
      className={
        "rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 " +
        (className || "")
      }
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span
            data-testid="compliance-chip"
            className={
              "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide " +
              (CHIP_STYLE[chip.state] || CHIP_STYLE.unknown)
            }
          >
            <span aria-hidden className="text-[10px]">
              {chip.state === "blocking" ? "●" : chip.state === "warning" ? "▲" : chip.state === "ready" ? "✓" : "○"}
            </span>
            <span>{chip.label}</span>
          </span>
          {Object.keys(rulepackVersions).length > 0 && (
            <span className="text-[10px] text-gray-500 font-mono">
              {Object.entries(rulepackVersions).map(([k, v]) => `${k} ${v}`).join(" · ")}
            </span>
          )}
        </div>
        {compliance && (
          <span className="text-[10px] uppercase tracking-[0.16em] text-gray-500">
            state: {compliance.state}
          </span>
        )}
      </div>

      {issues.length === 0 ? (
        <p className="text-[12px] text-gray-500 mt-3">
          {compliance
            ? "No compliance findings recorded for this record."
            : "Compliance findings not evaluated. Set the org's validation.mode to passive_persist or block to populate findings."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {issues.map((issue, i) => {
            const copy = explainCode(issue.code);
            const sev = severityCopy(issue.severity);
            return (
              <li
                key={`${issue.code}_${i}`}
                data-testid="compliance-finding"
                data-severity={issue.severity}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={"mt-1.5 inline-block h-2 w-2 rounded-full " + (SEVERITY_BAR[sev.tone] || SEVERITY_BAR.blue)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-300">
                        {sev.label}
                      </span>
                      <span className="text-[12px] text-white font-medium">{copy.title}</span>
                      <span className="text-[10px] font-mono text-gray-500 truncate">{issue.code}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-gray-300 leading-relaxed">{copy.explanation}</p>
                    {copy.action && (
                      <p className="mt-1 text-[11px] text-amber-200/85">
                        <span className="text-amber-300/90 font-semibold">Action:</span> {copy.action}
                      </p>
                    )}
                    {issue.source && (
                      <p className="mt-1 text-[10px] text-gray-500 italic">{issue.source}</p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
