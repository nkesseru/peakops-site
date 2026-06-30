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
import { EvidencePicker } from "@/components/recovery/EvidencePicker";
import { AddRecoveryActionModal } from "@/components/recovery/AddRecoveryActionModal";
import { ResolveCaseModal } from "@/components/recovery/ResolveCaseModal";
import { NextActionBlock } from "@/components/recovery/NextActionBlock";
import { WhereSection } from "@/components/recovery/WhereSection";
import { DoneActionsList } from "@/components/recovery/DoneActionsList";
import { CollapsibleCaseDetails } from "@/components/recovery/CollapsibleCaseDetails";
// PR 127d — mission-briefing card replaces the 2-stat hero +
// standalone WhatsWrongSection. Problem · Reason · Impact in one
// briefing-style top block, then WHERE, then YOUR NEXT MOVE.
import { MissionBriefingCard } from "@/components/recovery/MissionBriefingCard";
// PR 128b — suggested-actions panel sits between MISSION and WHERE
// so the operator's eye flows: What's wrong → What should I do.
import { SuggestedActionsPanel } from "@/components/recovery/SuggestedActionsPanel";
// PR 129b — Resubmission loop UI surfaces.
import { ResubmissionBanner } from "@/components/recovery/ResubmissionBanner";
import { AwaitingCustomerBanner } from "@/components/recovery/AwaitingCustomerBanner";
import { ResubmissionLinkResultModal } from "@/components/recovery/ResubmissionLinkResultModal";
// PR 131b — Phase 2 readiness strip; surfaces directly below MISSION
// to answer "Can I send this back?" before scrolling.
import { ReadinessStrip } from "@/components/recovery/ReadinessStrip";
import { useMemberNames } from "@/lib/recovery/useMemberNames";
import { TERMINAL_STATUSES } from "@/lib/recovery/displayConstants";
import type {
  GetRecoveryCaseResponse,
  RecoveryCaseDetail,
  RecoveryAction,
  RecoveryAuditEvent,
  RecoveryActionType,
  RecoveryCausePrimary,
  OwnerRole,
  SuggestedAction,
  MintResubmissionLinkResponse,
  RecoverySuggestionsBlock,
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
  // PR 128b — backend-filtered suggested action chain for cause.primary
  const [suggestedActions, setSuggestedActions] = useState<SuggestedAction[]>([]);
  // PR 131b — Phase 2 read-time suggestions block. Drives ReadinessStrip,
  // MissionBriefingCard revenue hint, and ResubmissionBanner pre-fill.
  const [suggestions, setSuggestions] = useState<RecoverySuggestionsBlock | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [busyActionId, setBusyActionId] = useState<string>("");
  const [opErr, setOpErr] = useState<string>("");

  // PR 128b — busy state for the suggestions panel (per-type single-add
  // and a separate flag for [Add all]).
  const [busySuggestionType, setBusySuggestionType] = useState<string>("");
  const [busyAddAll, setBusyAddAll] = useState(false);
  const [suggestionErr, setSuggestionErr] = useState<string>("");
  // PR 128b — busy state for cause-override write
  const [overrideBusy, setOverrideBusy] = useState(false);

  // PR 129b — resubmission mint state.
  const [mintBusy, setMintBusy] = useState(false);
  const [mintErr, setMintErr] = useState<string>("");
  const [mintedLink, setMintedLink] = useState<{ url: string; ordinal: number; token?: string } | null>(null);
  // PR recovery-B — progressive disclosure stage for the two-step
  // Regenerate-and-resubmit pipeline. "regenerating" while
  // exportIncidentPacketV1 is in flight, "minting" while
  // mintResubmissionLinkV1 is in flight, null when idle or done.
  const [mintStage, setMintStage] = useState<"regenerating" | "minting" | null>(null);
  // PR recovery-B — timestamp of the most recent successful export.
  // If mint fails after a successful export, retrying within the
  // window skips the re-export (the packet we just produced is still
  // fresh and waiting on the incident's packetMeta). 60s is generous
  // enough to cover slow network mints and short operator pauses.
  const [lastSuccessfulExportAt, setLastSuccessfulExportAt] = useState<number | null>(null);
  const EXPORT_FRESHNESS_WINDOW_MS = 60_000;
  // Stores the most-recently minted resubmission URL across the session
  // so the AwaitingCustomerBanner can render it even after the modal
  // closes. Lost on full reload (the cleartext token is never persisted).
  const [cachedReviewUrl, setCachedReviewUrl] = useState<string>("");

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
        setSuggestedActions(out.suggestedActions || []);
        setSuggestions(out.suggestions || null);
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

  // PR 128b — add a single suggested action. Reuses the same
  // addRecoveryActionV1 endpoint as the Add Action modal so the
  // backend wedge (deterministic ID, audit emit) stays one path.
  async function handleAddSuggested(s: SuggestedAction) {
    setSuggestionErr("");
    setBusySuggestionType(s.type);
    try {
      const res = await authedFetch(`/api/fn/addRecoveryActionV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId, caseId, actorUid,
          type: s.type,
          title: s.title,
          description: s.description || undefined,
          assigneeRole: s.assigneeRole || undefined,
        }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      setSuggestionErr(e?.message || String(e));
    } finally {
      setBusySuggestionType("");
    }
  }

  // PR 128b — add every suggested action. Sequential so a partial
  // failure leaves a coherent partial state and the operator can see
  // exactly which one broke. Backend dedupe-by-type ensures we never
  // double-add.
  async function handleAddAllSuggested(list: SuggestedAction[]) {
    setSuggestionErr("");
    setBusyAddAll(true);
    try {
      for (const s of list) {
        const res = await authedFetch(`/api/fn/addRecoveryActionV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgId, caseId, actorUid,
            type: s.type,
            title: s.title,
            description: s.description || undefined,
            assigneeRole: s.assigneeRole || undefined,
          }),
        });
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e: any) {
      setSuggestionErr(e?.message || String(e));
      // Refresh anyway so the operator sees which suggestions did land.
      await refresh();
    } finally {
      setBusyAddAll(false);
    }
  }

  // PR 128b — operator override for the inferred cause. Backend
  // clears cause.inferredFromComment on any manual cause.primary set,
  // so the badge disappears on next load.
  async function handleOverrideCause(newCause: RecoveryCausePrimary) {
    setOpErr("");
    setOverrideBusy(true);
    try {
      const res = await authedFetch(`/api/fn/updateRecoveryCaseV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId, caseId, actorUid,
          cause: { primary: newCause },
        }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      await refresh();
    } catch (e: any) {
      setOpErr(e?.message || String(e));
    } finally {
      setOverrideBusy(false);
    }
  }

  // PR recovery-B — combined Regenerate-and-resubmit pipeline.
  // Replaces the bare-mint flow (was PR 129b's handleMintResubmission).
  //
  // Pipeline:
  //   1. exportIncidentPacketV1 — produces a fresh signed packet,
  //      increments packetVersion, appends to packetMeta.history,
  //      retains the prior packet at its versioned storagePath.
  //   2. mintResubmissionLinkV1 — pins step 1's packetMeta into a new
  //      customer_review_links token, appends to case.packetVersions,
  //      flips case status to awaiting_customer, transitions incident
  //      to submitted_to_customer.
  //
  // Iron rule: if step 1 FAILS, step 2 MUST NOT run. Pinning a stale
  // (already-rejected) packet would re-send the SAME content to the
  // customer, defeating the recovery loop. Always-export is the safe
  // default — the lastSuccessfulExportAt freshness window only skips
  // step 1 on a fast retry of a previously-successful export.
  async function handleRegenerateAndResubmit(args: { changeSummary?: string }) {
    setMintErr("");
    setMintBusy(true);
    try {
      // ── Step 1 — Regenerate packet (skip if a recent successful export is still fresh) ──
      const nowMs = Date.now();
      const exportIsFresh =
        lastSuccessfulExportAt !== null &&
        (nowMs - lastSuccessfulExportAt) < EXPORT_FRESHNESS_WINDOW_MS;

      if (!exportIsFresh) {
        setMintStage("regenerating");
        const exportRes = await authedFetch(`/api/fn/exportIncidentPacketV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgId,
            incidentId: caseData?.incidentId,
            actorUid,
          }),
        });
        const exportOut: any = await exportRes.json().catch(() => ({ ok: false }));
        if (!exportRes.ok || !exportOut?.ok) {
          // Iron rule — never mint after a failed export. Bail out.
          throw new Error(
            exportOut?.detail ||
            exportOut?.error ||
            `Regenerate packet failed (HTTP ${exportRes.status})`
          );
        }
        setLastSuccessfulExportAt(Date.now());
      }

      // ── Step 2 — Mint the resubmission link (pins step 1's packet) ──
      setMintStage("minting");
      const res = await authedFetch(`/api/fn/mintResubmissionLinkV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId, caseId, actorUid,
          ...(args.changeSummary ? { changeSummary: args.changeSummary } : {}),
        }),
      });
      const out: MintResubmissionLinkResponse = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !out.ok || !out.url) {
        // Surface server detail when available so the operator sees
        // exactly why the mint refused (e.g. incident not in a
        // mintable state, outstanding pending packet). The export
        // ALREADY succeeded — leaving lastSuccessfulExportAt set so a
        // retry skips re-export and goes straight to mint.
        throw new Error(out.detail || out.error || `HTTP ${res.status}`);
      }
      // Compose full URL with origin for the modal display.
      const fullUrl = /^https?:\/\//.test(out.url)
        ? out.url
        : `${typeof window !== "undefined" ? window.location.origin : ""}${out.url}`;
      setMintedLink({
        url: fullUrl,
        ordinal: out.ordinal || 1,
        token: out.token,
      });
      setCachedReviewUrl(fullUrl);
      // Clear the freshness window after a successful mint — the case
      // has advanced to awaiting_customer; any future resubmission
      // pass starts a brand-new export cycle.
      setLastSuccessfulExportAt(null);
      await refresh();
    } catch (e: any) {
      setMintErr(e?.message || String(e));
    } finally {
      setMintBusy(false);
      setMintStage(null);
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

      {/* PR 127d — MISSION briefing card replaces the BigStat hero
          and the standalone WhatsWrongSection. Problem · Reason ·
          Impact in a briefing-style block. Revenue and aging are
          demoted to the footnote line inside the card. */}
      <MissionBriefingCard
        causePrimary={caseData.cause.primary || ""}
        customerComment={caseData.cause.customerComment}
        operatorNotes={caseData.cause.operatorNotes}
        revenueAtRisk={caseData.revenueAtRisk}
        daysOpen={caseData.daysOpen}
        inferredFromComment={Boolean(caseData.cause.inferredFromComment)}
        onOverrideCause={!isTerminal ? handleOverrideCause : undefined}
        overrideBusy={overrideBusy}
        revenueAtRiskSuggestion={suggestions?.revenueAtRisk}
      />

      {/* PR 131b — Readiness strip directly below MISSION, per decision
          lock 2026-06-08. Answers the single most important coordinator
          question: "Can I send this back?" Always renders when the
          suggestions block is present; green/red/neutral states with
          no amber. */}
      {suggestions?.resubmissionReadiness && (
        <ReadinessStrip readiness={suggestions.resubmissionReadiness} />
      )}

      {/* PR 128b — Suggested actions, sitting directly under MISSION.
          What's wrong? (above) → What should I do? (here).
          Hidden when empty (no cause, or all already added) or when
          case is terminal. */}
      {!isTerminal && suggestedActions.length > 0 && (
        <SuggestedActionsPanel
          suggestions={suggestedActions}
          busyType={busySuggestionType}
          busyAddAll={busyAddAll}
          errorMessage={suggestionErr}
          onAdd={handleAddSuggested}
          onAddAll={handleAddAllSuggested}
        />
      )}

      {/* WHERE */}
      <WhereSection
        jobTitle={caseData.jobTitle}
        jobLocation={caseData.jobLocation}
        incidentId={caseData.incidentId}
        orgId={orgId}
      />

      {/* PR 129b — Dominant CTA / state surface. Branches on case
          status so the coordinator always sees the single clearest
          "what to do next" panel:
            ready_to_resubmit   → ResubmissionBanner (mint CTA)
            awaiting_customer   → AwaitingCustomerBanner (informational)
            anything else open  → NextActionBlock (per-action CTAs)
          Terminal states fall through to the resolution summary below. */}
      {!isTerminal && caseData.status === "ready_to_resubmit" && (
        <ResubmissionBanner
          busy={mintBusy}
          stage={mintStage}
          errorMessage={mintErr}
          onRegenerateAndResubmit={handleRegenerateAndResubmit}
          changeSummarySuggestion={suggestions?.changeSummary ?? null}
        />
      )}
      {!isTerminal && caseData.status === "awaiting_customer" && (
        <AwaitingCustomerBanner
          currentPacket={
            caseData.packetVersions.find((p) => p.outcome === "pending")
            || caseData.packetVersions[caseData.packetVersions.length - 1]
          }
          cachedReviewUrl={cachedReviewUrl}
          daysOpen={caseData.daysOpen}
        />
      )}
      {!isTerminal &&
        caseData.status !== "ready_to_resubmit" &&
        caseData.status !== "awaiting_customer" && (
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
      {/* PR 129b — One-shot review URL after successful mint. After
          dismissal the cleartext token is gone. */}
      {mintedLink && (
        <ResubmissionLinkResultModal
          url={mintedLink.url}
          ordinal={mintedLink.ordinal}
          token={mintedLink.token}
          onClose={() => setMintedLink(null)}
        />
      )}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">{children}</div>;
}
