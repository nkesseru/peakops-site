// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Recovery case detail page. Revenue-first framing — every visible
// section answers one of the five questions:
//   What is wrong? → cause + customer comment
//   How much revenue is at risk? → hero stat
//   Who owns recovery? → ownership section
//   What is blocking acceptance? → Recovery Actions list
//   What happens next? → first open action + case action bar
//
// Audit timeline is collapsible (not visually dominant per the
// PR 127b scope-guard reminder).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { PriorityBadge } from "@/components/recovery/PriorityBadge";
import { CaseStatusBadge } from "@/components/recovery/StatusBadge";
import { RevenueDisplay } from "@/components/recovery/RevenueDisplay";
import { RecoveryActionListItem } from "@/components/recovery/RecoveryActionListItem";
import { EvidencePicker } from "@/components/recovery/EvidencePicker";
import { AddRecoveryActionModal } from "@/components/recovery/AddRecoveryActionModal";
import { ResolveCaseModal } from "@/components/recovery/ResolveCaseModal";
import { customerLabelFromTemplateKey } from "@/lib/recovery/customerLabelFromTemplateKey";
import {
  CAUSE_DISPLAY,
  OWNER_ROLE_DISPLAY,
  SOURCE_DISPLAY,
  TERMINAL_STATUSES,
  formatRevenue,
} from "@/lib/recovery/displayConstants";
import type {
  GetRecoveryCaseResponse,
  RecoveryCaseDetail,
  RecoveryAction,
  RecoveryAuditEvent,
  RecoveryActionType,
  OwnerRole,
  PacketVersionRef,
} from "@/lib/recovery/types";

type Props = {
  caseId: string;
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

export default function RecoveryCaseClient({ caseId }: Props) {
  return (
    <RequireAuth>
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <DetailContent caseId={caseId} />
        </div>
      </main>
    </RequireAuth>
  );
}

function DetailContent({ caseId }: { caseId: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const { user, claims } = useAuth();
  const role = String(claims?.role || "").toLowerCase();
  const isAdmin = role === "owner" || role === "admin" || role === "supervisor" || role === "coordinator";
  const actorUid = String(user?.uid || "").trim();
  const orgId = String(sp?.get("orgId") || "").trim();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [caseData, setCaseData] = useState<RecoveryCaseDetail | null>(null);
  const [actions, setActions] = useState<RecoveryAction[]>([]);
  const [audit, setAudit] = useState<RecoveryAuditEvent[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const [busyActionId, setBusyActionId] = useState<string>("");
  const [opErr, setOpErr] = useState<string>("");

  const [showAddAction, setShowAddAction] = useState(false);
  const [showResolve, setShowResolve] = useState(false);
  const [showEvidencePickerForActionId, setShowEvidencePickerForActionId] = useState<string>("");
  const [showAuditTimeline, setShowAuditTimeline] = useState(false);

  useEffect(() => {
    if (!orgId || !caseId || !actorUid) return;
    let cancelled = false;
    setLoading(true);
    setErr("");
    (async () => {
      try {
        const url = `/api/fn/getRecoveryCaseV1?orgId=${encodeURIComponent(orgId)}&caseId=${encodeURIComponent(caseId)}&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: GetRecoveryCaseResponse = await res.json().catch(() => ({ ok: false }));
        if (!res.ok || !out.ok || !out.case) {
          throw new Error(out.error || `HTTP ${res.status}`);
        }
        if (cancelled) return;
        setCaseData(out.case);
        setActions(out.actions || []);
        setAudit(out.audit || []);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Failed to load case.");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, caseId, actorUid, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const firstOpenAction = useMemo(
    () => actions.find((a) => a.status === "open" || a.status === "in_progress") || null,
    [actions]
  );
  const isTerminal = caseData ? TERMINAL_STATUSES.has(caseData.status) : false;

  async function callUpdateAction(actionId: string, body: Record<string, unknown>) {
    setBusyActionId(actionId);
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/updateRecoveryActionV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, caseId, actionId, actorUid, ...body }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    } finally {
      setBusyActionId("");
    }
  }

  async function handleAddAction(args: { type: RecoveryActionType; title: string; description?: string; assigneeRole?: OwnerRole }) {
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/addRecoveryActionV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, caseId, actorUid, ...args }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      setShowAddAction(false);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    }
  }

  async function handleAttachEvidence(actionId: string, selectedIds: string[]) {
    setBusyActionId(actionId);
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/updateRecoveryActionV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, caseId, actionId, actorUid, addEvidenceIds: selectedIds }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      setShowEvidencePickerForActionId("");
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    } finally {
      setBusyActionId("");
    }
  }

  async function handleResolve(args: { outcome: "recovered" | "partial_recovery" | "abandoned"; finalAmount?: number; notes?: string }) {
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/updateRecoveryCaseV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId, caseId, actorUid,
          status: args.outcome,
          resolution: args,
        }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        throw new Error(out.detail || out.error || `HTTP ${res.status}`);
      }
      setShowResolve(false);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    }
  }

  async function handleEscalate() {
    if (!caseData) return;
    if (caseData.status === "escalated") return;
    setOpErr("");
    try {
      const res = await authedFetch(`/api/fn/updateRecoveryCaseV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, caseId, actorUid, status: "escalated" }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    }
  }

  if (!isAdmin) {
    return <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">Recovery is admin/coordinator only.</div>;
  }
  if (!orgId) {
    return <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">Missing orgId.</div>;
  }
  if (loading) {
    return <div className="text-[12px] text-gray-500 italic py-8 text-center">Loading recovery case…</div>;
  }
  if (err) {
    return (
      <div className="rounded-xl border border-red-300/25 bg-red-500/[0.05] p-5 space-y-3">
        <div className="text-sm text-red-200">{err}</div>
        <button onClick={refresh} className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.06] hover:bg-white/[0.12]">Retry</button>
      </div>
    );
  }
  if (!caseData) {
    return <div className="text-gray-500 text-sm italic py-8 text-center">Case not found.</div>;
  }

  const customerLabel = customerLabelFromTemplateKey(caseData.templateKey) || "—";
  const causeLabel = caseData.cause.primary
    ? (CAUSE_DISPLAY[caseData.cause.primary as keyof typeof CAUSE_DISPLAY] || caseData.cause.primary)
    : "Not yet triaged";

  return (
    <div className="space-y-5">
      {/* Back nav */}
      <button
        onClick={() => router.push(`/recovery?orgId=${encodeURIComponent(orgId)}`)}
        className="text-[12px] text-gray-400 hover:text-gray-200"
      >
        ← Recovery cases
      </button>

      {/* Header + provenance */}
      <header className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
          Recovery case · {caseId.slice(0, 8)}
        </div>
        <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight">
          {customerLabel} · Cycle {caseData.cycleCount}
        </h1>
        <div className="text-[12px] text-gray-400">
          {caseData.templateKey && (
            <span className="font-mono">{caseData.templateKey}</span>
          )}
          {caseData.templateVersion != null && <span> · v{caseData.templateVersion}</span>}
          {caseData.rejection.source && (
            <span> · Source: {SOURCE_DISPLAY[caseData.rejection.source as keyof typeof SOURCE_DISPLAY] || caseData.rejection.source}</span>
          )}
        </div>
      </header>

      {/* Hero stats — At risk / Priority / Status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <HeroCard label="At risk">
          <RevenueDisplay revenue={caseData.revenueAtRisk} size="lg" />
        </HeroCard>
        <HeroCard label="Priority">
          <div className="flex items-center gap-2 pt-1">
            <PriorityBadge priority={caseData.priority} />
          </div>
          <div className="text-[10px] text-gray-500 mt-1.5">derived from revenue + aging</div>
        </HeroCard>
        <HeroCard label="Status">
          <div className="flex items-center gap-2 pt-1">
            <CaseStatusBadge status={caseData.status} />
          </div>
          <div className="text-[10px] text-gray-500 mt-1.5 tabular-nums">{caseData.daysOpen} day{caseData.daysOpen === 1 ? "" : "s"} aging</div>
        </HeroCard>
      </div>

      {/* Why */}
      <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5 space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">Why</div>
        <div className="text-sm text-white">
          <span className="text-gray-400">Cause:</span> {causeLabel}
        </div>
        {caseData.cause.customerComment && (
          <div className="text-[12px] text-gray-300">
            <span className="text-gray-500">Customer said:</span> &ldquo;{caseData.cause.customerComment}&rdquo;
          </div>
        )}
        {caseData.cause.operatorNotes && (
          <div className="text-[12px] text-gray-300">
            <span className="text-gray-500">Operator note:</span> {caseData.cause.operatorNotes}
          </div>
        )}
      </section>

      {/* Owner */}
      <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5 space-y-1.5">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">Owner</div>
        <div className="text-sm text-white">
          {caseData.ownership.owner ? (
            <>
              <span className="font-mono text-[12px] text-gray-300">{caseData.ownership.owner}</span>
              {caseData.ownership.ownerRole && (
                <span className="text-gray-500"> · {OWNER_ROLE_DISPLAY[caseData.ownership.ownerRole as keyof typeof OWNER_ROLE_DISPLAY] || caseData.ownership.ownerRole}</span>
              )}
            </>
          ) : (
            <span className="text-gray-500 italic">Unassigned</span>
          )}
        </div>
      </section>

      {/* Recovery Actions */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Recovery Actions ({actions.length})
          </div>
          {!isTerminal && (
            <button
              onClick={() => setShowAddAction(true)}
              className="text-[11px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10]"
            >
              + Add action
            </button>
          )}
        </div>
        {actions.length === 0 ? (
          <div className="text-[12px] text-gray-500 italic py-3 text-center rounded-xl border border-white/10 bg-white/[0.02]">
            No Recovery Actions yet.
          </div>
        ) : (
          <div className="space-y-2.5">
            {actions.map((a) => (
              <RecoveryActionListItem
                key={a.id}
                action={a}
                busy={busyActionId === a.id}
                onMarkInProgress={() => callUpdateAction(a.id, { status: "in_progress" })}
                onMarkDone={() => callUpdateAction(a.id, { status: "done" })}
                onAttachEvidence={() => setShowEvidencePickerForActionId(a.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Packet Versions */}
      {caseData.packetVersions.length > 0 && (
        <PacketVersionsList versions={caseData.packetVersions} />
      )}

      {/* Case actions */}
      {!isTerminal && (
        <section className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500 mb-2">Case actions</div>
          {opErr && (
            <div className="mb-2 rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
              {opErr}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {caseData.status !== "escalated" && (
              <button
                onClick={handleEscalate}
                className="text-[12px] px-3 py-1.5 rounded-full border border-orange-400/30 bg-orange-500/10 text-orange-200 hover:bg-orange-500/20"
              >
                Escalate
              </button>
            )}
            <button
              onClick={() => setShowResolve(true)}
              className="text-[12px] px-3 py-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
            >
              Resolve…
            </button>
          </div>
        </section>
      )}

      {isTerminal && caseData.resolution && (
        <section className="rounded-xl border border-emerald-300/25 bg-emerald-500/[0.05] px-4 py-3.5 space-y-1">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-emerald-200/80">Resolved</div>
          <div className="text-sm text-emerald-100">
            Outcome: <span className="font-medium">{caseData.resolution.outcome}</span>
            {caseData.resolution.finalAmount != null && (
              <span> · Final ${caseData.resolution.finalAmount.toLocaleString()}</span>
            )}
          </div>
          {caseData.resolution.notes && (
            <div className="text-[12px] text-emerald-100/80 italic">&ldquo;{caseData.resolution.notes}&rdquo;</div>
          )}
          {caseData.resolution.resolvedAt && (
            <div className="text-[11px] text-emerald-200/60 tabular-nums">{fmtIso(caseData.resolution.resolvedAt)}</div>
          )}
        </section>
      )}

      {/* Audit timeline — collapsible */}
      <section className="rounded-xl border border-white/10 bg-white/[0.02]">
        <button
          onClick={() => setShowAuditTimeline((v) => !v)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.03] transition"
        >
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">
            Audit timeline · {audit.length} events
          </span>
          <span className="text-[11px] text-gray-500">{showAuditTimeline ? "Collapse" : "Expand"}</span>
        </button>
        {showAuditTimeline && (
          <div className="border-t border-white/[0.05] px-4 py-3 space-y-1.5">
            {audit.length === 0 ? (
              <div className="text-[12px] text-gray-500 italic">No audit events yet.</div>
            ) : (
              audit.map((ev) => (
                <div key={ev.id} className="text-[11px] flex items-start gap-2">
                  <span className="text-gray-500 tabular-nums shrink-0 w-32">{fmtIso(ev.createdAt)}</span>
                  <span className="text-gray-300 font-mono">{ev.type}</span>
                  {ev.actorUid && (
                    <span className="text-gray-500">· {ev.actorUid.slice(0, 8)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* Modals */}
      {showAddAction && (
        <AddRecoveryActionModal
          submitting={false}
          errorMessage={opErr}
          onCancel={() => setShowAddAction(false)}
          onSubmit={handleAddAction}
        />
      )}
      {showResolve && (
        <ResolveCaseModal
          baselineAmount={Number(caseData.revenueAtRisk.amount) || 0}
          submitting={false}
          errorMessage={opErr}
          onCancel={() => setShowResolve(false)}
          onSubmit={handleResolve}
        />
      )}
      {showEvidencePickerForActionId && (
        <EvidencePicker
          orgId={orgId}
          incidentId={caseData.incidentId}
          alreadyAttachedIds={(actions.find((a) => a.id === showEvidencePickerForActionId)?.evidence || []).map((e) => e.evidenceId)}
          submitting={busyActionId === showEvidencePickerForActionId}
          onCancel={() => setShowEvidencePickerForActionId("")}
          onConfirm={(ids) => handleAttachEvidence(showEvidencePickerForActionId, ids)}
        />
      )}
    </div>
  );
}

function HeroCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function PacketVersionsList({ versions }: { versions: PacketVersionRef[] }) {
  return (
    <section className="space-y-2.5">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
        Packet versions ({versions.length})
      </div>
      <div className="space-y-2">
        {versions.map((p, i) => {
          const outcomeClass =
            p.outcome === "accepted" ? "text-emerald-300" :
            p.outcome === "rejected" ? "text-red-300" :
            "text-gray-400";
          return (
            <div key={`${p.packetVersionId}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-300">
                  #{i + 1} · <span className="font-mono text-[10px] text-gray-500">{p.packetVersionId.slice(0, 12)}…</span>
                </span>
                <span className={`uppercase tracking-wider text-[10px] ${outcomeClass}`}>{p.outcome || "pending"}</span>
              </div>
              {p.customerComment && (
                <div className="text-[11px] text-gray-400 mt-1 italic">&ldquo;{p.customerComment}&rdquo;</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
