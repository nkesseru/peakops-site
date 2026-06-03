// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Recovery cases queue. Revenue-first framing:
//   1. Header KPI strip: Revenue at risk | Open cases | Recovered (placeholder)
//   2. Filter chips (priority, status, my-cases vs all)
//   3. Sortable table — priority desc, then revenue desc, then aging desc
//
// Uses listRecoveryCasesV1 (PR 127a2). Priority on response is
// system-derived (PR 127a2 _recoveryPriority.js). No direct
// Firestore reads (override #1).

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { PriorityBadge } from "@/components/recovery/PriorityBadge";
import { CaseStatusBadge } from "@/components/recovery/StatusBadge";
import { RevenueDisplay } from "@/components/recovery/RevenueDisplay";
import { customerLabelFromTemplateKey } from "@/lib/recovery/customerLabelFromTemplateKey";
import { CAUSE_DISPLAY, PRIORITY_RANK, formatRevenue, TERMINAL_STATUSES } from "@/lib/recovery/displayConstants";
import type {
  ListRecoveryCasesResponse,
  RecoveryCaseListItem,
  RecoveryPriority,
  RecoveryStatus,
} from "@/lib/recovery/types";

type FilterPriority = "all" | RecoveryPriority;
type FilterStatus = "all" | "active" | RecoveryStatus;
type FilterView = "mine" | "all";

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

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [cases, setCases] = useState<RecoveryCaseListItem[]>([]);
  const [totals, setTotals] = useState<{ cases: number; openCases: number; openRevenue: number }>({ cases: 0, openCases: 0, openRevenue: 0 });
  const [refreshTick, setRefreshTick] = useState(0);

  const [view, setView] = useState<FilterView>("all");
  const [filterPriority, setFilterPriority] = useState<FilterPriority>("all");
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
        if (!res.ok || !out.ok) {
          throw new Error(out.error || `HTTP ${res.status}`);
        }
        if (cancelled) return;
        setCases(Array.isArray(out.cases) ? out.cases : []);
        setTotals(out.totals || { cases: 0, openCases: 0, openRevenue: 0 });
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

  const filtered = useMemo(() => {
    const arr = cases.slice();

    let filteredArr = arr;
    if (view === "mine" && actorUid) {
      filteredArr = filteredArr.filter((c) => c.owner === actorUid);
    }
    if (filterPriority !== "all") {
      filteredArr = filteredArr.filter((c) => c.priority === filterPriority);
    }
    if (filterStatus === "active") {
      filteredArr = filteredArr.filter((c) => !TERMINAL_STATUSES.has(c.status));
    } else if (filterStatus !== "all") {
      filteredArr = filteredArr.filter((c) => c.status === filterStatus);
    }

    // Sort: priority desc, then revenue desc, then daysOpen desc.
    filteredArr.sort((a, b) => {
      const rp = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
      if (rp !== 0) return rp;
      const rr = (Number(b.revenueAtRisk.amount) || 0) - (Number(a.revenueAtRisk.amount) || 0);
      if (rr !== 0) return rr;
      return (Number(b.daysOpen) || 0) - (Number(a.daysOpen) || 0);
    });

    return filteredArr;
  }, [cases, view, filterPriority, filterStatus, actorUid]);

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-gray-300">
        You don&apos;t have access to recovery cases. Recovery is owner / admin / supervisor / coordinator only.
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
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight">Recovery cases</h1>
          <p className="text-[12px] text-gray-400 mt-0.5">
            Revenue Protection &amp; Recovery — work required to get money unstuck.
          </p>
        </div>
      </header>

      {/* KPI strip */}
      <HeaderStrip totals={totals} loading={loading} />

      {/* Filter chips */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">View:</span>
          <FilterChip active={view === "mine"} onClick={() => setView("mine")}>My cases</FilterChip>
          <FilterChip active={view === "all"} onClick={() => setView("all")}>All cases</FilterChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">Priority:</span>
          <FilterChip active={filterPriority === "all"} onClick={() => setFilterPriority("all")}>All</FilterChip>
          <FilterChip active={filterPriority === "critical"} onClick={() => setFilterPriority("critical")}>Critical</FilterChip>
          <FilterChip active={filterPriority === "high"} onClick={() => setFilterPriority("high")}>High</FilterChip>
          <FilterChip active={filterPriority === "medium"} onClick={() => setFilterPriority("medium")}>Medium</FilterChip>
          <FilterChip active={filterPriority === "low"} onClick={() => setFilterPriority("low")}>Low</FilterChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">Status:</span>
          <FilterChip active={filterStatus === "all"} onClick={() => setFilterStatus("all")}>All</FilterChip>
          <FilterChip active={filterStatus === "active"} onClick={() => setFilterStatus("active")}>Active</FilterChip>
          <FilterChip active={filterStatus === "open"} onClick={() => setFilterStatus("open")}>Open</FilterChip>
          <FilterChip active={filterStatus === "triaged"} onClick={() => setFilterStatus("triaged")}>Triaged</FilterChip>
          <FilterChip active={filterStatus === "in_progress"} onClick={() => setFilterStatus("in_progress")}>In progress</FilterChip>
          <FilterChip active={filterStatus === "awaiting_customer"} onClick={() => setFilterStatus("awaiting_customer")}>Awaiting</FilterChip>
          <FilterChip active={filterStatus === "recovered"} onClick={() => setFilterStatus("recovered")}>Recovered</FilterChip>
        </div>
      </div>

      {/* Table */}
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
        <CasesTable cases={filtered} onRowClick={(c) => router.push(`/recovery/${c.caseId}?orgId=${encodeURIComponent(orgId)}`)} />
      )}
    </div>
  );
}

function HeaderStrip({ totals, loading }: { totals: { cases: number; openCases: number; openRevenue: number }; loading: boolean }) {
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
        value="—"
        subtext="coming soon"
        accent="muted"
      />
    </div>
  );
}

function KpiCard({ label, value, subtext, accent }: { label: string; value: string; subtext: string; accent: "amber" | "white" | "muted" }) {
  const valueClass = accent === "amber"
    ? "text-amber-200"
    : accent === "muted"
      ? "text-gray-500"
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

function CasesTable({ cases, onRowClick }: { cases: RecoveryCaseListItem[]; onRowClick: (c: RecoveryCaseListItem) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
      <table className="w-full text-[13px]">
        <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2.5 text-left font-medium">Priority</th>
            <th className="px-3 py-2.5 text-left font-medium">Revenue at risk</th>
            <th className="px-3 py-2.5 text-left font-medium">Customer</th>
            <th className="px-3 py-2.5 text-left font-medium">Cause</th>
            <th className="px-3 py-2.5 text-left font-medium">Owner</th>
            <th className="px-3 py-2.5 text-left font-medium">Status</th>
            <th className="px-3 py-2.5 text-right font-medium">Aging</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {cases.map((c) => {
            const customerLabel = customerLabelFromTemplateKey(c.templateKey) || "—";
            const causeLabel = c.cause.primary ? (CAUSE_DISPLAY[c.cause.primary as keyof typeof CAUSE_DISPLAY] || c.cause.primary) : <span className="text-gray-500 italic">not triaged</span>;
            return (
              <tr
                key={c.caseId}
                onClick={() => onRowClick(c)}
                className="hover:bg-white/[0.04] cursor-pointer transition"
              >
                <td className="px-3 py-3"><PriorityBadge priority={c.priority} size="sm" /></td>
                <td className="px-3 py-3"><RevenueDisplay revenue={c.revenueAtRisk} size="sm" /></td>
                <td className="px-3 py-3 text-gray-200 truncate max-w-[180px]">{customerLabel}</td>
                <td className="px-3 py-3 text-gray-300 text-[12px] truncate max-w-[200px]">{causeLabel}</td>
                <td className="px-3 py-3 text-gray-400 text-[11px] font-mono truncate max-w-[120px]">{c.owner || "—"}</td>
                <td className="px-3 py-3"><CaseStatusBadge status={c.status} size="sm" /></td>
                <td className="px-3 py-3 text-right text-gray-300 tabular-nums">{c.daysOpen}d</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
