// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// Recovery cases queue — distracted-user reshape.
//
// Header KPI strip: Revenue at risk | Open cases | Recovered (placeholder)
// Filters: my-cases vs all, status. (No priority filter — priority is
// no longer surfaced in primary UI.)
// Columns reordered: Revenue · Aging · Customer · What's wrong · Next · Owner · Status
// Owner shows resolved names via listOrgMembersV1.
// Backend sort still uses derived priority — UI display does not.

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { CaseStatusBadge } from "@/components/recovery/StatusBadge";
import { RevenueDisplay } from "@/components/recovery/RevenueDisplay";
import { customerLabelFromTemplateKey } from "@/lib/recovery/customerLabelFromTemplateKey";
import { useMemberNames } from "@/lib/recovery/useMemberNames";
import { CAUSE_DISPLAY, PRIORITY_RANK, formatRevenue, TERMINAL_STATUSES, ACTION_TYPE_DISPLAY } from "@/lib/recovery/displayConstants";
import type {
  ListRecoveryCasesResponse,
  RecoveryCaseListItem,
  RecoveryStatus,
  RecoveryActionType,
} from "@/lib/recovery/types";

// PR 127c-b — for the queue's "Next" column, we need each case's
// first-open Recovery Action. listRecoveryCasesV1 doesn't return
// actions, so we fetch each case's actions on demand via a small
// helper that caches per session.

type FilterStatus = "all" | "active" | RecoveryStatus;
type FilterView = "mine" | "all";

type NextActionCache = Record<string, { type: RecoveryActionType; title: string; status: string } | "none" | "loading">;

export default function RecoveryListClient() {
  return (
    <RequireAuth>
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
          <ListContent />
        </div>
      </main>
    </RequireAuth>
  );
}

function ListContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user, claims } = useAuth();
  const role = String(claims?.role || "").toLowerCase();
  const isAdmin = role === "owner" || role === "admin" || role === "supervisor" || role === "coordinator";
  const actorUid = String(user?.uid || "").trim();

  const initialOrgId = String(sp?.get("orgId") || "").trim();
  const [orgId, setOrgId] = useState<string>(initialOrgId);
  useEffect(() => {
    if (!orgId && typeof window !== "undefined") {
      try {
        const fromLs = String(localStorage.getItem("peakops_orgId") || "").trim();
        if (fromLs) setOrgId(fromLs);
      } catch { /* */ }
    }
  }, [orgId]);

  const memberNames = useMemberNames(orgId, actorUid);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [cases, setCases] = useState<RecoveryCaseListItem[]>([]);
  const [totals, setTotals] = useState<{ cases: number; openCases: number; openRevenue: number; recoveredRevenue: number }>({ cases: 0, openCases: 0, openRevenue: 0, recoveredRevenue: 0 });
  const [refreshTick, setRefreshTick] = useState(0);
  const [nextActionByCase, setNextActionByCase] = useState<NextActionCache>({});

  const [view, setView] = useState<FilterView>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("active");

  useEffect(() => {
    if (!orgId || !actorUid) return;
    let cancelled = false;
    setLoading(true);
    setErr("");
    (async () => {
      try {
        const url = `/api/fn/listRecoveryCasesV1?orgId=${encodeURIComponent(orgId)}&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: ListRecoveryCasesResponse = await res.json().catch(() => ({ ok: false }));
        if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setCases(Array.isArray(out.cases) ? out.cases : []);
        setTotals(out.totals || { cases: 0, openCases: 0, openRevenue: 0, recoveredRevenue: 0 });
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || "Failed to load recovery cases.");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, actorUid, refreshTick]);

  // Fetch next action per case (only for non-terminal cases — terminal
  // ones don't need "what's next?"). Done in parallel after the list
  // load; cached in state.
  useEffect(() => {
    if (!orgId || !actorUid || cases.length === 0) return;
    const toFetch = cases.filter((c) =>
      !TERMINAL_STATUSES.has(c.status) && !nextActionByCase[c.caseId]
    );
    if (toFetch.length === 0) return;

    setNextActionByCase((prev) => {
      const next = { ...prev };
      for (const c of toFetch) next[c.caseId] = "loading";
      return next;
    });

    Promise.all(toFetch.map(async (c) => {
      try {
        const url = `/api/fn/getRecoveryCaseV1?orgId=${encodeURIComponent(orgId)}&caseId=${encodeURIComponent(c.caseId)}&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) return [c.caseId, "none" as const];
        const actions = Array.isArray(out.actions) ? out.actions : [];
        const open = actions.find((a: any) =>
          a.status === "open" || a.status === "in_progress" || a.status === "blocked"
        );
        return [c.caseId, open ? { type: open.type, title: open.title, status: open.status } : "none" as const];
      } catch {
        return [c.caseId, "none" as const];
      }
    })).then((results) => {
      setNextActionByCase((prev) => {
        const next = { ...prev };
        for (const [id, val] of results as [string, any][]) next[id] = val;
        return next;
      });
    });
  }, [orgId, actorUid, cases, nextActionByCase]);

  const filtered = useMemo(() => {
    const arr = cases.slice();

    let filteredArr = arr;
    if (view === "mine" && actorUid) {
      filteredArr = filteredArr.filter((c) => c.owner === actorUid);
    }
    if (filterStatus === "active") {
      filteredArr = filteredArr.filter((c) => !TERMINAL_STATUSES.has(c.status));
    } else if (filterStatus !== "all") {
      filteredArr = filteredArr.filter((c) => c.status === filterStatus);
    }

    // Sort: priority desc (backend-derived) → revenue desc → daysOpen desc.
    // Priority is NOT shown in UI but is still used for ordering.
    filteredArr.sort((a, b) => {
      const rp = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
      if (rp !== 0) return rp;
      const rr = (Number(b.revenueAtRisk.amount) || 0) - (Number(a.revenueAtRisk.amount) || 0);
      if (rr !== 0) return rr;
      return (Number(b.daysOpen) || 0) - (Number(a.daysOpen) || 0);
    });

    return filteredArr;
  }, [cases, view, filterStatus, actorUid]);

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">
        You don&apos;t have access to recovery cases.
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">
        Missing orgId — append <span className="font-mono">?orgId=…</span> to the URL.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight">Recovery cases</h1>
        <p className="text-[12px] text-gray-400 mt-0.5">
          Open cases waiting on action.
        </p>
      </header>

      {/* KPI strip */}
      <HeaderStrip totals={totals} loading={loading} />

      {/* Filters (no priority filter in distracted-user UI) */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">View:</span>
          <FilterChip active={view === "mine"} onClick={() => setView("mine")}>My cases</FilterChip>
          <FilterChip active={view === "all"} onClick={() => setView("all")}>All cases</FilterChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">Status:</span>
          <FilterChip active={filterStatus === "all"} onClick={() => setFilterStatus("all")}>All</FilterChip>
          <FilterChip active={filterStatus === "active"} onClick={() => setFilterStatus("active")}>Active</FilterChip>
          <FilterChip active={filterStatus === "open"} onClick={() => setFilterStatus("open")}>Open</FilterChip>
          <FilterChip active={filterStatus === "in_progress"} onClick={() => setFilterStatus("in_progress")}>In progress</FilterChip>
          {/* PR 129b — ready_to_resubmit + awaiting_customer surface as
              first-class queue filters; `triaged` filter dropped. */}
          <FilterChip active={filterStatus === "ready_to_resubmit"} onClick={() => setFilterStatus("ready_to_resubmit")}>Ready to resubmit</FilterChip>
          <FilterChip active={filterStatus === "awaiting_customer"} onClick={() => setFilterStatus("awaiting_customer")}>Awaiting</FilterChip>
          <FilterChip active={filterStatus === "recovered"} onClick={() => setFilterStatus("recovered")}>Recovered</FilterChip>
        </div>
      </div>

      {loading ? (
        <div className="text-[12px] text-gray-500 italic py-8 text-center">Loading recovery cases…</div>
      ) : err ? (
        <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-4 py-3 text-[13px] text-red-200">
          {err}
          <button
            className="ml-2 text-[12px] underline hover:text-red-100"
            onClick={() => setRefreshTick((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 text-center text-[13px] text-gray-400">
          No recovery cases match these filters.
        </div>
      ) : (
        <CasesTable
          cases={filtered}
          nextActionByCase={nextActionByCase}
          resolveOwner={memberNames.resolve}
          onRowClick={(c) => router.push(`/recovery/${c.caseId}?orgId=${encodeURIComponent(orgId)}`)}
        />
      )}
    </div>
  );
}

function HeaderStrip({ totals, loading }: { totals: { cases: number; openCases: number; openRevenue: number; recoveredRevenue: number }; loading: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <KpiCard
        label="Revenue at risk"
        value={loading ? "—" : formatRevenue(totals.openRevenue)}
        subtext={loading ? "loading" : "across open cases"}
        accent="amber"
      />
      <KpiCard
        label="Open cases"
        value={loading ? "—" : String(totals.openCases)}
        subtext={loading ? "loading" : `${totals.cases} total`}
        accent="white"
      />
      <KpiCard
        label="Recovered revenue"
        value={loading ? "—" : (totals.recoveredRevenue > 0 ? formatRevenue(totals.recoveredRevenue) : "$0")}
        subtext={loading ? "loading" : "across recovered cases"}
        accent="emerald"
      />
    </div>
  );
}

function KpiCard({ label, value, subtext, accent }: { label: string; value: string; subtext: string; accent: "amber" | "white" | "emerald" }) {
  const valueClass = accent === "amber"
    ? "text-amber-200"
    : accent === "emerald"
      ? "text-emerald-200"
      : "text-white";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-500">{label}</div>
      <div className={`text-2xl sm:text-3xl font-semibold mt-1 tabular-nums ${valueClass}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5">{subtext}</div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-[11px] px-2.5 py-1 rounded-full border transition " +
        (active
          ? "bg-white text-black border-white"
          : "bg-white/[0.04] text-gray-300 border-white/15 hover:bg-white/[0.08]")
      }
    >
      {children}
    </button>
  );
}

function CasesTable({
  cases,
  nextActionByCase,
  resolveOwner,
  onRowClick,
}: {
  cases: RecoveryCaseListItem[];
  nextActionByCase: NextActionCache;
  resolveOwner: (uid?: string | null) => string;
  onRowClick: (c: RecoveryCaseListItem) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
      <table className="w-full text-[13px]">
        <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2.5 text-left font-medium">Revenue</th>
            <th className="px-3 py-2.5 text-right font-medium">Aging</th>
            <th className="px-3 py-2.5 text-left font-medium">Customer</th>
            <th className="px-3 py-2.5 text-left font-medium">What&apos;s wrong</th>
            <th className="px-3 py-2.5 text-left font-medium">Next</th>
            <th className="px-3 py-2.5 text-left font-medium">Owner</th>
            <th className="px-3 py-2.5 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {cases.map((c) => {
            const customerLabel = customerLabelFromTemplateKey(c.templateKey) || c.jobTitle || "—";
            const causeLabel = c.cause.primary
              ? (CAUSE_DISPLAY[c.cause.primary as keyof typeof CAUSE_DISPLAY] || c.cause.primary)
              : null;
            const ownerName = c.owner ? resolveOwner(c.owner) : "";
            const next = nextActionByCase[c.caseId];
            const isTerminal = TERMINAL_STATUSES.has(c.status);

            return (
              <tr
                key={c.caseId}
                onClick={() => onRowClick(c)}
                className="hover:bg-white/[0.04] cursor-pointer transition"
              >
                <td className="px-3 py-3"><RevenueDisplay revenue={c.revenueAtRisk} size="sm" /></td>
                <td className="px-3 py-3 text-right text-gray-200 tabular-nums">{c.daysOpen}d</td>
                <td className="px-3 py-3 text-gray-200 truncate max-w-[200px]">{customerLabel}</td>
                <td className="px-3 py-3 text-[12px] truncate max-w-[200px]">
                  {causeLabel
                    ? <span className="text-gray-300">{causeLabel}</span>
                    : <span className="text-amber-300/70 italic">no cause yet</span>
                  }
                </td>
                <td className="px-3 py-3 text-[12px] truncate max-w-[220px]">
                  {isTerminal
                    ? <span className="text-gray-500 italic">—</span>
                    : next === "loading"
                      ? <span className="text-gray-500 italic">…</span>
                      : (next === "none" || !next) && c.status === "awaiting_customer"
                        ? <span className="text-gray-300">Waiting on customer review</span>
                        : next === "none" || !next
                          ? <span className="text-amber-300/80 font-medium">Needs triage</span>
                          : <span className="text-gray-200">{ACTION_TYPE_DISPLAY[next.type as RecoveryActionType] || next.type}</span>
                  }
                </td>
                <td className="px-3 py-3 text-gray-300 text-[12px] truncate max-w-[120px]">
                  {ownerName || <span className="text-gray-500 italic">—</span>}
                </td>
                <td className="px-3 py-3"><CaseStatusBadge status={c.status} size="sm" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
