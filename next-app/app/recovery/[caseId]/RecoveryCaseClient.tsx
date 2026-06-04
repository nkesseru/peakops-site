// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// Recovery case detail — distracted-user redesign.
//
// Information hierarchy approved 2026-06-04:
//   1. What is wrong?    → cause + customer comment (top, prominent)
//   2. Where is the job? → job name + address + maps link
//   3. What do I do?     → NEXT ACTION block (dominant CTA)
//   4. Did I finish it?  → single-line list of done actions
// Plus: collapsible footer with everything else (priority, owner, etc.)
//
// Priority is INVISIBLE in the primary UI — used for sort only on
// the queue. Member uids are resolved to names via listOrgMembersV1.
// Recovery actions require address or GPS; if neither, show data
// defect flag (do not hide).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { CaseStatusBadge } from "@/components/recovery/StatusBadge";
import { RevenueDisplay } from "@/components/recovery/RevenueDisplay";
import { EvidencePicker } from "@/components/recovery/EvidencePicker";
import { AddRecoveryActionModal } from "@/components/recovery/AddRecoveryActionModal";
import { ResolveCaseModal } from "@/components/recovery/ResolveCaseModal";
import { NextActionBlock } from "@/components/recovery/NextActionBlock";
import { WhereSection } from "@/components/recovery/WhereSection";
import { WhatsWrongSection } from "@/components/recovery/WhatsWrongSection";
import { DoneActionsList } from "@/components/recovery/DoneActionsList";
import { CollapsibleCaseDetails } from "@/components/recovery/CollapsibleCaseDetails";
import { useMemberNames } from "@/lib/recovery/useMemberNames";
import { TERMINAL_STATUSES } from "@/lib/recovery/displayConstants";
import type {
  GetRecoveryCaseResponse,
  RecoveryCaseDetail,
  RecoveryAction,
  RecoveryAuditEvent,
  RecoveryActionType,
  OwnerRole,
} from "@/lib/recovery/types";

type Props = { caseId: string };

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

  const memberNames = useMemberNames(orgId, actorUid);

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

  // Split actions: NEXT (first open / in_progress) vs DONE (the rest).
  // Blocked actions also surface as the "next" attention since they need
  // operator unblocking.
  const { nextAction, doneActions, otherOpenActions } = useMemo(() => {
    const next = actions.find((a) => a.status === "open" || a.status === "in_progress" || a.status === "blocked") || null;
    const done = actions.filter((a) => a.status === "done" || a.status === "skipped");
    const otherOpen = actions.filter((a) => a !== next && (a.status === "open" || a.status === "in_progress" || a.status === "blocked"));
    return { nextAction: next, doneActions: done, otherOpenActions: otherOpen };
  }, [actions]);

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
        body: JSON.stringify({ orgId, caseId, actorUid, status: args.outcome, resolution: args }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.detail || out.error || `HTTP ${res.status}`);
      setShowResolve(false);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    }
  }

  async function handleEscalate() {
    if (!caseData || caseData.status === "escalated") return;
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

  if (!isAdmin) return <Panel>Recovery is admin/coordinator only.</Panel>;
  if (!orgId) return <Panel>Missing orgId.</Panel>;
  if (loading) return <div className="text-[12px] text-gray-500 italic py-8 text-center">Loading recovery case…</div>;
  if (err) return (
    <div className="rounded-xl border border-red-300/25 bg-red-500/[0.05] p-5 space-y-3">
      <div className="text-sm text-red-200">{err}</div>
      <button onClick={refresh} className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.06] hover:bg-white/[0.12]">Retry</button>
    </div>
  );
  if (!caseData) return <div className="text-gray-500 text-sm italic py-8 text-center">Case not found.</div>;

  return (
    <div className="space-y-5">
      {/* Back */}
      <button
        onClick={() => router.push(`/recovery?orgId=${encodeURIComponent(orgId)}`)}
        className="text-[12px] text-gray-400 hover:text-gray-200"
      >
        ← Recovery
      </button>

      {/* TWO BIG NUMBERS — Revenue at risk + Days aging */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4">
        <BigStat
          value={<RevenueDisplay revenue={caseData.revenueAtRisk} size="lg" showType={true} />}
          label="At risk"
        />
        <BigStat
          value={
            <span className="text-2xl sm:text-3xl font-semibold tabular-nums text-white">
              {caseData.daysOpen} <span className="text-base font-medium text-gray-400">day{caseData.daysOpen === 1 ? "" : "s"}</span>
            </span>
          }
          label="Aging"
        />
      </section>

      {/* WHAT'S WRONG */}
      <WhatsWrongSection
        causePrimary={caseData.cause.primary || ""}
        customerComment={caseData.cause.customerComment}
        operatorNotes={caseData.cause.operatorNotes}
      />

      {/* WHERE */}
      <WhereSection
        jobTitle={caseData.jobTitle}
        jobLocation={caseData.jobLocation}
        incidentId={caseData.incidentId}
        orgId={orgId}
      />

      {/* NEXT ACTION — dominant CTA */}
      {!isTerminal && (
        <NextActionBlock
          nextAction={nextAction}
          assigneeNameResolver={memberNames.resolve}
          busy={busyActionId === (nextAction?.id || "")}
          opErr={opErr}
          onMarkInProgress={() => nextAction && callUpdateAction(nextAction.id, { status: "in_progress" })}
          onMarkDone={() => nextAction && callUpdateAction(nextAction.id, { status: "done" })}
          onAttachEvidence={() => nextAction && setShowEvidencePickerForActionId(nextAction.id)}
          onAddAction={() => setShowAddAction(true)}
          onResolveCase={() => setShowResolve(true)}
          allActionsDone={!nextAction && actions.length > 0 && doneActions.length === actions.length}
        />
      )}

      {/* Terminal case — show resolution summary */}
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
        </section>
      )}

      {/* DONE (and other open actions if any) — single-line list, visible without expansion */}
      {(doneActions.length > 0 || otherOpenActions.length > 0) && (
        <DoneActionsList
          done={doneActions}
          otherOpen={otherOpenActions}
          assigneeNameResolver={memberNames.resolve}
        />
      )}

      {/* Add Recovery Action — small footer trigger if case still active */}
      {!isTerminal && nextAction && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setShowAddAction(true)}
            className="text-[11px] text-gray-400 hover:text-gray-200 px-3 py-1 rounded-full border border-white/10 hover:border-white/20"
          >
            + Add Recovery Action
          </button>
        </div>
      )}

      {/* Escalate (small, separate from primary CTA) */}
      {!isTerminal && caseData.status !== "escalated" && (
        <div className="text-center">
          <button
            type="button"
            onClick={handleEscalate}
            className="text-[11px] text-orange-300/70 hover:text-orange-200 px-3 py-1 rounded-full border border-orange-400/20 hover:border-orange-400/40"
          >
            Escalate
          </button>
        </div>
      )}

      {/* Collapsible: status, owner, source, packet versions, audit — everything de-emphasized */}
      <CollapsibleCaseDetails
        caseData={caseData}
        audit={audit}
        assigneeNameResolver={memberNames.resolve}
      />

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

function BigStat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">{label}</div>
      <div className="mt-1.5">{value}</div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">{children}</div>;
}
