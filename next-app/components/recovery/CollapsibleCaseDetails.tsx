// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// Everything de-emphasized lives here: status, owner+role, source,
// template + version + cycle, packet versions, audit timeline.
// Collapsed by default per distracted-user framing.
//
// Priority is NOT shown anywhere in the UI (PR 127c-b override #4).

"use client";

import { useState } from "react";
import { CaseStatusBadge } from "./StatusBadge";
import { OWNER_ROLE_DISPLAY, SOURCE_DISPLAY } from "@/lib/recovery/displayConstants";
import type {
  RecoveryCaseDetail,
  RecoveryAuditEvent,
  OwnerRole,
} from "@/lib/recovery/types";

type Props = {
  caseData: RecoveryCaseDetail;
  audit: RecoveryAuditEvent[];
  assigneeNameResolver: (uid?: string | null) => string;
};

function fmtIso(iso?: string | null): string {
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

export function CollapsibleCaseDetails({ caseData, audit, assigneeNameResolver }: Props) {
  const [open, setOpen] = useState(false);

  const ownerName = caseData.ownership.owner ? assigneeNameResolver(caseData.ownership.owner) : "";
  const ownerRoleLabel = caseData.ownership.ownerRole
    ? OWNER_ROLE_DISPLAY[caseData.ownership.ownerRole as OwnerRole] || caseData.ownership.ownerRole
    : "";
  const sourceLabel = caseData.rejection.source
    ? SOURCE_DISPLAY[caseData.rejection.source as keyof typeof SOURCE_DISPLAY] || caseData.rejection.source
    : "";

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.03] transition"
      >
        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
          Case details
        </span>
        <span className="text-[11px] text-gray-500">{open ? "Collapse" : "Expand"}</span>
      </button>

      {open && (
        <div className="border-t border-white/[0.05] px-4 py-3 space-y-4">
          {/* Status + ownership */}
          <div className="space-y-2 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-24">Status</span>
              <CaseStatusBadge status={caseData.status} size="sm" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-24">Owner</span>
              <span className="text-gray-200">
                {ownerName || <span className="text-gray-500 italic">unassigned</span>}
                {ownerRoleLabel && <span className="text-gray-500"> · {ownerRoleLabel}</span>}
              </span>
            </div>
            {sourceLabel && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">Source</span>
                <span className="text-gray-200">{sourceLabel}</span>
              </div>
            )}
            {caseData.templateKey && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">Template</span>
                <span className="text-gray-300 font-mono text-[11px] truncate">
                  {caseData.templateKey}
                  {caseData.templateVersion != null && <span className="text-gray-500"> · v{caseData.templateVersion}</span>}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-24">Cycle</span>
              <span className="text-gray-200">{caseData.cycleCount}</span>
            </div>
            {caseData.openedAt && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">Opened</span>
                <span className="text-gray-300">{fmtIso(caseData.openedAt)}</span>
              </div>
            )}
          </div>

          {/* Packet versions */}
          {caseData.packetVersions.length > 0 && (
            <div className="pt-3 border-t border-white/[0.05] space-y-2">
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
                Packet versions ({caseData.packetVersions.length})
              </div>
              <div className="space-y-1.5">
                {caseData.packetVersions.map((p, i) => {
                  const outcomeClass =
                    p.outcome === "accepted" ? "text-emerald-300" :
                    p.outcome === "rejected" ? "text-red-300" :
                    "text-gray-400";
                  return (
                    <div key={`${p.packetVersionId}-${i}`} className="text-[11px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-500">#{i + 1}</span>
                        <span className={`uppercase tracking-wider text-[10px] ${outcomeClass}`}>{p.outcome || "pending"}</span>
                        <span className="text-gray-500 font-mono">{p.packetVersionId.slice(0, 12)}…</span>
                      </div>
                      {p.customerComment && (
                        <div className="text-gray-400 italic text-[11px] ml-4">&ldquo;{p.customerComment}&rdquo;</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Audit timeline */}
          <div className="pt-3 border-t border-white/[0.05] space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
              Audit timeline ({audit.length})
            </div>
            {audit.length === 0 ? (
              <div className="text-[11px] text-gray-500 italic">No audit events.</div>
            ) : (
              audit.map((ev) => (
                <div key={ev.id} className="text-[11px] flex items-start gap-2">
                  <span className="text-gray-500 tabular-nums shrink-0 w-32 text-[10px]">{fmtIso(ev.createdAt)}</span>
                  <span className="text-gray-300 font-mono text-[10px]">{ev.type}</span>
                  {ev.actorUid && (
                    <span className="text-gray-500 text-[10px]">· {assigneeNameResolver(ev.actorUid)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
