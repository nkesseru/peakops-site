"use client";

/**
 * PEAKOPS_RECORDS_INDEX_V1 (PR 76 — Records Index)
 *
 * The operational record library. NOT a generic incident grid —
 * this surface answers "what's in flight, what's awaiting me,
 * what's accepted" in proof/acceptance vocabulary.
 *
 * Architecture:
 *   - Single round trip on mount: GET /api/fn/listIncidentsV1
 *     ?orgId={claims.orgIds[0]}&limit=50
 *   - orgId resolution mirrors /my-work and the AppTopBar chip —
 *     uses the user's first claim'd org until PR 77 adds a
 *     switcher.
 *   - Client-side filtering on the result (cap=50 makes server-side
 *     query params unnecessary). Filter persisted in URL via
 *     ?filter= so the view is shareable + refresh-stable.
 *   - Cards, not table rows. Each card shows the dossier voice
 *     fields the operator cares about, and a single CTA whose
 *     label + route is determined by the record's lifecycle.
 *
 * What this file deliberately is NOT:
 *   - Not a kanban board, dashboard, project tracker, or CRM
 *   - Not search, pagination, or bulk actions
 *   - Not multi-org aggregation (PR 77 territory)
 *   - Not a server-rendered list — the underlying endpoint is
 *     authed; client-side fetch is the canonical path for every
 *     authed surface in the app
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";
import { useAuth } from "@/hooks/useAuth";
import { authedFetch } from "@/lib/apiClient";
import {
  incidentStatusLabel,
  incidentStatusPill,
  normalizeIncidentStatusShared,
} from "@/lib/incidents/incidentStatus";
import { getArchetypeDetails } from "@/lib/incidents/newIncidentDraft";
// PR 103b — Cache-only readiness pill. Renders only when the row
// carries readinessCache.state from listIncidentsV1 (today: never;
// forward-compatible for when backend plumbs it through). Omits on
// "not_available" per ReadinessPill internal rule.
import { ReadinessPill } from "@/components/ReadinessPill";

const FILTER_VALUES = ["all", "pending", "active", "accepted"] as const;
type FilterKey = (typeof FILTER_VALUES)[number];

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  pending: "In Progress",
  active: "Active",
  accepted: "Accepted",
};

type IncidentRow = {
  incidentId: string;
  orgId?: string;
  title?: string;
  status?: string;
  location?: string;
  priority?: string;
  // PR 77b: customer / agency / project surfaced by listIncidentsV1
  // (PR 77a). Optional — absent on older records or when the
  // operator didn't fill the field at create time.
  customer?: string;
  // PR 84: archetype surfaced by listIncidentsV1 (PR 83a) so the
  // card can render the proof-package archetype as a small eyebrow
  // above the title. Optional — absent on older records.
  archetype?: string;
  createdAt?: string;
  updatedAt?: string;
  submittedAt?: string;
  closedAt?: string;
  evidenceCount?: number;
  taskCount?: number;
  approvedTaskCount?: number;
  packetReady?: boolean;
  // PR 103b — Optional cached readiness state from
  // incident.readinessCache (PR 103a write path). PR 105 lit up
  // the pill by plumbing this field through listIncidentsV1.
  // PR 107a extends the projection with missingCount +
  // missingItemsPreview when state === "requirements_missing"
  // so cards can show a one-line explanation of WHAT is missing
  // (PR 107b — this UI).
  readinessCache?: {
    state?: "ready_for_submission" | "requirements_missing" | "not_available";
    // PR 107a — present only when state === "requirements_missing"
    // AND the cache had a populated checks[] array. Backend caps
    // the preview at 3 labels in declared snapshot order and
    // truncates each at 80 chars.
    missingCount?: number;
    missingItemsPreview?: string[];
  };
};

type ListResp = {
  ok?: boolean;
  items?: IncidentRow[];
  incidents?: IncidentRow[];
  error?: string;
};

/**
 * Lifecycle → filter membership.
 *   - Active   = draft | open
 *   - Pending  = in_progress | submitted_to_customer | customer_rejected
 *               (operator action expected — either in progress, waiting on
 *                customer review, or customer asked for correction)
 *   - Accepted = closed | customer_accepted
 *               (closed = operator-accepted; customer_accepted = customer
 *                signed off on the packet — both are terminal accept states)
 */
function lifecycleFilter(status: string): FilterKey {
  const s = normalizeIncidentStatusShared(status);
  if (s === "in_progress" || s === "submitted_to_customer" || s === "customer_rejected") return "pending";
  if (s === "closed" || s === "customer_accepted") return "accepted";
  return "active"; // draft, open, anything else
}

function matchesFilter(row: IncidentRow, filter: FilterKey): boolean {
  if (filter === "all") return true;
  return lifecycleFilter(String(row.status || "")) === filter;
}

/**
 * CTA label + destination for a row, based on lifecycle. Routes
 * include orgId so downstream guards don't trip.
 */
function rowCTA(row: IncidentRow): { label: string; href: string } {
  const id = encodeURIComponent(String(row.incidentId || ""));
  const orgQs = row.orgId ? `?orgId=${encodeURIComponent(row.orgId)}` : "";
  const s = normalizeIncidentStatusShared(String(row.status || ""));

  if (s === "in_progress" || s === "submitted_to_customer" || s === "customer_rejected") {
    return { label: "Open review →", href: `/incidents/${id}/review${orgQs}` };
  }
  if (s === "closed" || s === "customer_accepted") {
    return { label: "Open dossier →", href: `/incidents/${id}/summary${orgQs}` };
  }
  if (s === "draft") {
    // Draft drops into the same overview but with the next-step
    // banner re-armed (?next=capture-proof) so the operator sees
    // the prompt PR 70 wired up on first arrival.
    const join = orgQs ? "&" : "?";
    return {
      label: "Continue proof capture →",
      href: `/incidents/${id}${orgQs}${join}next=capture-proof`,
    };
  }
  // open + anything else → record overview
  return { label: "Continue proof capture →", href: `/incidents/${id}${orgQs}` };
}

function lastActivityLabel(row: IncidentRow): string {
  const iso = row.updatedAt || row.submittedAt || row.createdAt || "";
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const EMPTY_COPY: Record<FilterKey, string> = {
  all: "No field records yet. Open a new field record to get started.",
  pending: "No records are in progress right now.",
  active: "No active records in proof capture.",
  accepted: "No accepted packets yet. They'll appear here as work is approved.",
};

export default function RecordsClient() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <Body />
      </Suspense>
    </RequireAuth>
  );
}

function Body() {
  const router = useRouter();
  const sp = useSearchParams();
  const { claims } = useAuth();
  const orgId = (claims?.orgIds || [])[0] || "";

  const rawFilter = String(sp?.get("filter") || "all").toLowerCase();
  const filter: FilterKey = (FILTER_VALUES as readonly string[]).includes(rawFilter)
    ? (rawFilter as FilterKey)
    : "all";

  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");

    (async () => {
      try {
        const url = `/api/fn/listIncidentsV1?orgId=${encodeURIComponent(orgId)}&limit=50`;
        const res = await authedFetch(url, { cache: "no-store" });
        const txt = await res.text().catch(() => "");
        let out: ListResp = {};
        try {
          out = txt ? JSON.parse(txt) : {};
        } catch {
          out = {};
        }
        if (cancelled) return;
        if (!res.ok || !out?.ok) {
          throw new Error(out?.error || `Could not load records (HTTP ${res.status})`);
        }
        // Some endpoints return `items`, others `incidents` — be lenient.
        const list = Array.isArray(out.items)
          ? out.items
          : Array.isArray(out.incidents)
            ? out.incidents
            : [];
        setRows(list);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: rows.length, pending: 0, active: 0, accepted: 0 };
    for (const r of rows) {
      const k = lifecycleFilter(String(r.status || ""));
      if (k in c) c[k] += 1;
    }
    return c;
  }, [rows]);

  const filtered = useMemo(
    () => rows.filter((r) => matchesFilter(r, filter)),
    [rows, filter],
  );

  function setFilter(next: FilterKey) {
    const qs = new URLSearchParams(Array.from(sp?.entries() || []));
    if (next === "all") {
      qs.delete("filter");
    } else {
      qs.set("filter", next);
    }
    const q = qs.toString();
    router.replace(`/records${q ? `?${q}` : ""}`, { scroll: false });
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-8">
        <header className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Field records
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight text-white">
            Field records
          </h1>
          <p className="text-[14px] text-gray-400 leading-relaxed max-w-prose">
            Accepted packets, pending approvals, and active proof capture.
          </p>
        </header>

        <nav aria-label="Lifecycle filter" className="flex flex-wrap items-center gap-2">
          {FILTER_VALUES.map((k) => {
            const active = filter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                aria-current={active ? "page" : undefined}
                className={
                  "px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors " +
                  (active
                    ? "bg-amber-500/12 border-amber-300/25 text-amber-100"
                    : "bg-white/[0.02] border-white/10 text-gray-400 hover:text-gray-100 hover:bg-white/[0.06]")
                }
              >
                {FILTER_LABELS[k]}
                <span
                  className={
                    "ml-2 text-[10px] " + (active ? "text-amber-200/80" : "text-gray-500")
                  }
                >
                  {counts[k]}
                </span>
              </button>
            );
          })}
        </nav>

        {!orgId ? (
          <MissingOrgPanel />
        ) : error ? (
          <ErrorBanner message={error} onRetry={() => router.refresh()} />
        ) : loading ? (
          <LoadingPanel />
        ) : filtered.length === 0 ? (
          <EmptyPanel filter={filter} />
        ) : (
          <ul className="space-y-3">
            {filtered.map((row) => (
              <li key={row.incidentId}>
                <RecordCard row={row} router={router} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function RecordCard({ row, router }: { row: IncidentRow; router: ReturnType<typeof useRouter> }) {
  const cta = rowCTA(row);
  const title = String(row.title || "").trim() || "Untitled field record";
  const loc = String(row.location || "").trim();
  const customer = String(row.customer || "").trim();
  // PR 84: archetype eyebrow. getArchetypeDetails returns null for
  // empty / unknown / legacy enum values so the eyebrow simply
  // doesn't render for older records — calmer than showing a raw
  // snake_case key.
  const archetypeDetails = getArchetypeDetails(row.archetype);
  const evCount = Number.isFinite(row.evidenceCount as number) ? Number(row.evidenceCount) : null;
  const age = lastActivityLabel(row);

  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
      <div className="px-4 py-4 sm:px-5 sm:py-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {/* PR 84: archetype eyebrow sits above the title so the
              card reads as "this kind of proof package" before the
              specific title. Same dossier voice as "FIELD RECORD"
              eyebrows elsewhere in the app. */}
          {archetypeDetails ? (
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              {archetypeDetails.label}
            </div>
          ) : null}
          <div className="flex items-start gap-3">
            <h2 className="text-[15px] font-semibold text-white leading-snug truncate flex-1">
              {title}
            </h2>
            <span
              className={
                "shrink-0 text-[10px] uppercase tracking-[0.14em] font-semibold px-2 py-0.5 rounded-full border " +
                incidentStatusPill(row.status)
              }
            >
              {incidentStatusLabel(row.status)}
            </span>
          </div>
          {/* PR 77b: customer / agency / project sits between the
              title and the location. Slightly brighter weight than
              location (text-gray-300 vs text-gray-400) so the
              "who the packet is for" reads first when present, but
              calm enough not to compete with the title. Omitted
              when absent — listIncidentsV1 only sends it for
              records that actually have a value. */}
          {customer ? (
            <div className="text-[12px] text-gray-300 truncate">{customer}</div>
          ) : null}
          {loc ? (
            <div className="text-[12px] text-gray-400 truncate">{loc}</div>
          ) : null}
          <div className="text-[11px] text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {evCount !== null ? (
              <span>
                {evCount} {evCount === 1 ? "proof item" : "proof items"}
              </span>
            ) : (
              <span>— evidence</span>
            )}
            {age ? (
              <>
                <span aria-hidden="true" className="text-white/15">·</span>
                <span>last activity {age}</span>
              </>
            ) : null}
            {row.packetReady ? (
              <>
                <span aria-hidden="true" className="text-white/15">·</span>
                <span className="text-emerald-200/80">packet ready</span>
              </>
            ) : null}
            {/* PR 103b — Cache-only readiness pill. Renders only
                when readinessCache.state is "ready_for_submission"
                or "requirements_missing". "not_available" + missing
                cache both omit (handled inside ReadinessPill). */}
            {row.readinessCache?.state &&
             row.readinessCache.state !== "not_available" ? (
              <>
                <span aria-hidden="true" className="text-white/15">·</span>
                <ReadinessPill state={row.readinessCache.state} size="sm" />
              </>
            ) : null}
          </div>

          {/* PR 107b — Missing-items explanation subline. Renders
              ONLY on requirements_missing cards when the backend
              projected a non-empty missingItemsPreview. Format:
                Missing: A · B · +N more
              Tone is amber-tinted muted text so it reads as
              context, not as an error or warning. CTA below is
              unaffected; this is informational only. */}
          {row.readinessCache?.state === "requirements_missing" &&
           Array.isArray(row.readinessCache.missingItemsPreview) &&
           row.readinessCache.missingItemsPreview.length > 0 ? (
            <div className="text-[11px] text-gray-400 truncate">
              <span className="text-amber-200/70 font-medium">Missing:</span>{" "}
              {row.readinessCache.missingItemsPreview.map((label, i) => (
                <span key={i}>
                  {i > 0 ? (
                    <span aria-hidden="true" className="text-white/15"> · </span>
                  ) : null}
                  <span>{label}</span>
                </span>
              ))}
              {typeof row.readinessCache.missingCount === "number" &&
               row.readinessCache.missingCount > row.readinessCache.missingItemsPreview.length ? (
                <>
                  <span aria-hidden="true" className="text-white/15"> · </span>
                  <span className="text-gray-500 italic">
                    +{row.readinessCache.missingCount - row.readinessCache.missingItemsPreview.length} more
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="shrink-0">
          <button
            type="button"
            onClick={() => router.push(cta.href)}
            className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors whitespace-nowrap"
          >
            {cta.label}
          </button>
        </div>
      </div>
    </article>
  );
}

function MissingOrgPanel() {
  const router = useRouter();
  return (
    <div className="rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] p-5 sm:p-6 space-y-3">
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
        Field records
      </div>
      <div className="text-xl font-semibold text-white">Select an organization</div>
      <p className="text-[14px] text-gray-300 leading-relaxed">
        Field records belong to an organization. Open this page from a
        workspace link or pick an organization from the Team page.
      </p>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => router.push("/team")}
          className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
        >
          Open Team
        </button>
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="px-3 py-1.5 rounded-full text-[12px] text-gray-400 hover:text-gray-100 transition-colors"
        >
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-6 text-[13px] text-gray-400">
      Loading field records…
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-400/30 bg-red-500/[0.06] px-4 py-4 space-y-2">
      <div className="text-[13px] font-semibold text-red-100">Could not load field records</div>
      <div className="text-[12px] text-red-200/90 break-words">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

function EmptyPanel({ filter }: { filter: FilterKey }) {
  const router = useRouter();
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-8 sm:px-6 sm:py-10 text-center space-y-4">
      <div className="text-[14px] text-gray-300 leading-relaxed max-w-prose mx-auto">
        {EMPTY_COPY[filter]}
      </div>
      {filter === "all" ? (
        <div>
          <button
            type="button"
            onClick={() => router.push("/incidents/new")}
            className="px-4 py-2 rounded-full text-[12px] font-medium bg-white text-black hover:bg-white/90 transition-colors"
          >
            Open a new field record →
          </button>
        </div>
      ) : null}
    </div>
  );
}
