"use client";

function bucketTone(bucket: string) {
  switch (String(bucket || "")) {
    case "needs_review":
      return {
        wrap: "border-blue-500/25 bg-blue-500/[0.04]",
        chip: "bg-blue-500/15 border-blue-400/30 text-blue-100",
        title: "text-blue-100",
        sub: "text-blue-200/70",
        bar: "bg-blue-400/80",
      };
    case "update_requested":
      return {
        wrap: "border-violet-500/25 bg-violet-500/[0.05]",
        chip: "bg-violet-500/15 border-violet-400/30 text-violet-100",
        title: "text-violet-100",
        sub: "text-violet-200/70",
        bar: "bg-violet-400/80",
      };
    case "active":
      return {
        wrap: "border-cyan-500/20 bg-cyan-500/[0.03]",
        chip: "bg-cyan-500/12 border-cyan-400/25 text-cyan-100",
        title: "text-cyan-100",
        sub: "text-cyan-200/65",
        bar: "bg-cyan-400/75",
      };
    case "approved":
      return {
        wrap: "border-emerald-500/25 bg-emerald-500/[0.04]",
        chip: "bg-emerald-500/15 border-emerald-400/30 text-emerald-100",
        title: "text-emerald-100",
        sub: "text-emerald-200/70",
        bar: "bg-emerald-400/80",
      };
    default:
      return {
        wrap: "border-white/[0.08] bg-white/[0.03]",
        chip: "bg-white/[0.06] border-white/[0.12] text-white",
        title: "text-white",
        sub: "text-gray-400",
        bar: "bg-white/60",
      };
  }
}

function bucketBlurb(bucket: string) {
  switch (String(bucket || "")) {
    case "needs_review": return "Supervisor action required";
    case "update_requested": return "Waiting on field response";
    case "active": return "Field work in progress";
    case "approved": return "Locked and artifact-ready";
    default: return "";
  }
}
import { useEffect, useMemo, useState } from "react";
import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";
import { incidentStatusLabel, incidentStatusPill, normalizeIncidentStatusShared } from "@/lib/incidents/incidentStatus";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import { isDemoArtifact } from "@/lib/incidents/demoHygiene";

// Demo-safety filter for the hero card. Returns true when an incident
// looks like real operator data — i.e. its title doesn't match the
// known smoke/E2E artifact patterns. Used to keep the hero polished
// during demos without forcing a hardcoded target.
//
// Patterns excluded:
//   - "E2E recovery — loop", "E2E version-pin verification — …"
//   - "SMOKE PR85-87 · Proof cockpit test"
//   - "PR108-SMOKE · Readiness Freshness", "PR120-SMOKE · Provenance"
//   - "dummy-fake" / similar
//
// If NO incident passes the filter, the heroItem derivation falls
// back to the unfiltered list (so cold/early-stage orgs still get a
// hero card). Records without a title are excluded outright since
// they'd render as "Untitled record" in the hero — not flattering.
function looksRealForHero(title: unknown): boolean {
  const t = String(title || "").trim();
  if (!t) return false;
  if (/^e2e[ _-]/i.test(t)) return false;
  if (/^smoke[ _·-]/i.test(t)) return false;
  if (/smoke[ _-]?test/i.test(t)) return false;
  if (/^pr\d+[a-z]?[ _·-]/i.test(t)) return false;
  if (/^dummy[ _-]?/i.test(t)) return false;
  return true;
}

type Incident = {
  incidentId: string;
  orgId: string;
  status?: string;
  // PEAKOPS_DASHBOARD_DEMO_SAFE_V1
  // Server now plumbs the real incident.title; cards prefer this
  // over the raw incidentId so the dashboard reads as operational
  // record vs Firestore admin tool.
  title?: string;
  location?: string;
  evidenceCount?: number;
  reviewable?: number;
  approved?: number;
  updateRequested?: boolean;
  lastEvent?: string;
  updatedAgo?: string;
  updatedSec?: number;
  latestJobTitle?: string;
  thumbUrl?: string;
  customer?: string;
  priority?: string;
  updatedAt?: string;
};

function humanizeAgo(iso?: string): string {
  const s = String(iso || "").trim();
  if (!s) return "—";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d`;
}

function humanizeEvent(v?: string) {
  const s = String(v || "").trim();
  if (!s) return "—";
  const map: Record<string, string> = {
    SUPERVISOR_REQUEST_UPDATE: "Supervisor requested update",
    EVIDENCE_ADDED: "Evidence added",
    JOB_APPROVED: "Job approved",
    JOB_COMPLETED: "Job completed",
    FIELD_ARRIVED: "Field arrived",
    NOTES_SAVED: "Notes saved",
  };
  return map[s] || s.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

// readinessChip removed. It depended on per-job fields (i.approved /
// i.reviewable / i.updateRequested) that no longer come from the
// listIncidentsV1 data source (post-KPI-refactor), so every card
// fell through to the static "Active" label regardless of true
// status. Per-card status now uses the canonical lifecycle pill
// (incidentStatusLabel + incidentStatusPill) directly inside
// IncidentCard, so the chip tells the truth without an indirection.

type BucketKey = "needs_review" | "update_requested" | "active" | "approved";

// Status-based bucketing — mirrors Records' lifecycleFilter so the
// Dashboard KPI counts match the Records page. Previously this read
// per-job fields (reviewable / approved) that arrived via the
// /api/dashboard server route, but that route is currently broken
// (hardcoded single-seed + dev-admin actor 403s — see
// fix(dashboard): source KPI counts from incidents).
//
//   needs_review     = in_progress | submitted_to_customer | customer_rejected
//                      (operator action expected — work in progress,
//                       waiting on customer review, or correction asked)
//   approved         = closed | customer_accepted
//                      (operator-accepted or customer-signed-off)
//   active           = draft | open | anything else (catch-all)
//   update_requested = (unused; bucket key kept for downstream code
//                      paths that still reference it — always empty
//                      until a real data source is wired)
function primaryBucket(i: Incident): BucketKey {
  const s = normalizeIncidentStatusShared(i.status);
  if (s === "in_progress" || s === "submitted_to_customer" || s === "customer_rejected") return "needs_review";
  if (s === "closed" || s === "customer_accepted") return "approved";
  return "active";
}

function bucketPriority(i: Incident): number {
  const b = primaryBucket(i);
  if (b === "needs_review") return 1;
  if (b === "update_requested") return 2;
  if (b === "active") return 3;
  return 4;
}


function incidentHref(i: Incident): string {
  const qs = new URLSearchParams();
  if (i.orgId) qs.set("orgId", String(i.orgId));
  const q = qs.toString();
  return `/incidents/${encodeURIComponent(i.incidentId)}${q ? `?${q}` : ""}`;
}

function reviewHref(i: Incident): string {
  const qs = new URLSearchParams();
  if (i.orgId) qs.set("orgId", String(i.orgId));
  const q = qs.toString();
  return `/incidents/${encodeURIComponent(i.incidentId)}/review${q ? `?${q}` : ""}`;
}


function getAgeSec(i: Incident): number {
  const now = Date.now() / 1000;
  return Math.max(0, Math.floor(now - Number(i.updatedSec || 0)));
}

function staleFlag(i: Incident): { label: string; tone: string } | null {
  const age = getAgeSec(i);
  const bucket = primaryBucket(i);

  if (bucket === "update_requested" && age > 3600) {
    return { label: "Waiting >1h", tone: "border-violet-400/20 bg-violet-500/10 text-violet-200" };
  }
  if (bucket === "needs_review" && age > 1800) {
    return { label: "Review aging", tone: "border-blue-400/20 bg-blue-500/10 text-blue-200" };
  }
  if (bucket === "active" && age > 4 * 3600) {
    return { label: "Idle >4h", tone: "border-amber-400/20 bg-amber-500/10 text-amber-200" };
  }
  return null;
}

function StatCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="text-[11px] uppercase tracking-[0.16em] text-gray-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

async function doExport(i: Incident) {
  const r = await fetch("/api/fn/exportIncidentPacketV1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ incidentId: i.incidentId, orgId: i.orgId }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.url) {
    window.open(j.url, "_blank", "noreferrer");
    return;
  }
  throw new Error(j?.error || "Export failed");
}

function IncidentCard({ i }: { i: Incident }) {
  const tone = bucketTone(String((i as any)?.bucket || ""));

  const stale = staleFlag(i);
  const [exporting, setExporting] = useState(false);

  const openIncident = () => {
    window.location.href = incidentHref(i);
  };

  const openReview = (ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    window.location.href = reviewHref(i);
  };

  const openExport = async (ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    try {
      setExporting(true);
      await doExport(i);
    } catch (e) {
      console.error(e);
      alert("Export failed. Check console.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openIncident}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openIncident();
        }
      }}
      className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 cursor-pointer hover:bg-white/[0.045] transition"
      title={`Open ${i.incidentId}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* PEAKOPS_DASHBOARD_DEMO_SAFE_V1
                Prefer incident.title (plumbed through /api/dashboard
                from getIncidentV1's doc shape). Fallback to "Untitled
                incident" rather than the raw Firestore ID; the raw
                reference is still available via the card's title
                tooltip for audit lookups. */}
            <div className="text-lg font-semibold">{i.title || "Untitled incident"}</div>
            <span className={"px-2 py-1 rounded-full border text-xs " + incidentStatusPill(i.status)}>
              {incidentStatusLabel(i.status)}
            </span>
            {stale ? (
              <span className={`px-2 py-1 rounded-full border text-xs ${stale.tone}`}>{stale.label}</span>
            ) : null}
          </div>

          <div className="text-xs text-gray-400 mt-1">{i.orgId}</div>
        </div>
      </div>

      {/* Thumbnail tile renders only when the list source actually
          carries a thumbUrl. After the dashboard data source moved
          from /api/dashboard (per-card evidence fetch) to bulk
          listIncidentsV1 (no thumbnail field), this is always
          absent in production. Suppressing the tile collapses the
          grid to full-width metric tiles instead of rendering a
          permanent "No thumbnail" placeholder on every card. */}
      <div className={i.thumbUrl ? "grid grid-cols-1 md:grid-cols-[160px_1fr] gap-4 mt-4" : "mt-4"}>
        {i.thumbUrl ? (
          <div className="rounded-xl border border-white/[0.08] bg-black/20 overflow-hidden min-h-[120px] flex items-center justify-center">
            <img
              src={i.thumbUrl}
              alt={`${i.incidentId} evidence`}
              className="w-full h-[120px] object-cover"
            />
          </div>
        ) : null}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Evidence</div>
            <div className="mt-1">{i.evidenceCount || 0}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Customer</div>
            <div className="mt-1 truncate">{i.customer || "—"}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Priority</div>
            <div className="mt-1">{i.priority || "normal"}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Last Activity</div>
            <div className="mt-1">{humanizeAgo(i.updatedAt)}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-4">
        <button
          className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/[0.1] hover:bg-white/[0.12]"
          onClick={(e) => {
            e.stopPropagation();
            openIncident();
          }}
        >
          Open Incident
        </button>

        <button
          className="px-3 py-2 rounded-xl bg-blue-500/20 border border-blue-400/20 hover:bg-blue-500/30"
          onClick={openReview}
        >
          Review
        </button>

        <button
          className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/[0.1] hover:bg-white/[0.12] disabled:opacity-50"
          disabled={exporting}
          onClick={openExport}
        >
          {exporting ? "Exporting…" : "Export Packet"}
        </button>
      </div>
    </div>
  );
}

function BucketSection({ title, items }: { title: string; items: Incident[] }) {
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">{title}</div>
        <div className="text-xs text-gray-500">{items.length}</div>
      </div>

      <div className="grid gap-4">
        {/* PEAKOPS_DASHBOARD_POLISH_V1
            Bucket empty-state copy below — calmer + more operational
            than the prior "No records in this state right now." */}
        {items.length ? items.map((i) => <IncidentCard key={`${i.orgId}:${i.incidentId}`} i={i} />) : (
          <div className="text-gray-500 text-sm">No active incidents need attention right now.</div>
        )}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const { claims } = useAuth();
  const claimsOrgId = (claims?.orgIds || [])[0] || "";
  const [items, setItems] = useState<Incident[]>([]);
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const [orgs, setOrgs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [exportingVisible, setExportingVisible] = useState(false);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const org = String(sp.get("org") || "all");
      setOrgFilter(org || "all");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (orgFilter === "all") url.searchParams.delete("org");
      else url.searchParams.set("org", orgFilter);
      window.history.replaceState({}, "", url.toString());
    } catch {}
  }, [orgFilter]);

  async function load() {
    // KPI counts now sourced from listIncidentsV1 with the user's
    // real Bearer token (via authedFetch), mirroring the Records
    // page. The previous /api/dashboard route fetched ONE hardcoded
    // seed with a fake "dev-admin" actorUid, which post-auth-retrofit
    // returns permission-denied for every sub-fetch — leaving the
    // KPI tiles stuck at 0 while Records correctly showed the org's
    // real 19 records. Same endpoint + same lifecycle bucketing
    // pattern Records uses → counts now match Records exactly.
    if (!claimsOrgId) {
      setItems([]);
      setOrgs([]);
      setLoading(false);
      setLastSync(Date.now());
      return;
    }
    try {
      setLoading(true);
      const url = `/api/fn/listIncidentsV1?orgId=${encodeURIComponent(claimsOrgId)}&limit=50`;
      const r = await authedFetch(url, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      // listIncidentsV1 returns `incidents` (or `items` on some endpoints) — accept both.
      const list = Array.isArray(j?.items) ? j.items : (Array.isArray(j?.incidents) ? j.incidents : []);
      setItems(list);
      // Single-org scope here — populate the org chip with the claim's org
      // so the existing filter UI keeps a sensible value.
      setOrgs(claimsOrgId ? [claimsOrgId] : []);
      setLastSync(Date.now());
    } catch {
      setItems([]);
      setOrgs([]);
      setLastSync(Date.now());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
    }, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsOrgId]);

  const visible = useMemo(() => {
    // Filter chain: org scope → demo-hygiene. The latter hides obvious
    // smoke/test/seed records from operator queues; protected demo
    // record IDs (see demoHygiene.ts) are always allowed through.
    return items
      .filter((i) => orgFilter === "all" || i.orgId === orgFilter)
      .filter((i) => !isDemoArtifact(i));
  }, [items, orgFilter]);

  const grouped = useMemo(() => {
    const out = {
      needs_review: [] as Incident[],
      update_requested: [] as Incident[],
      active: [] as Incident[],
      approved: [] as Incident[],
    };

    const sorted = visible.slice().sort((a, b) => {
      const p = bucketPriority(a) - bucketPriority(b);
      if (p !== 0) return p;
      return Number(b.updatedSec || 0) - Number(a.updatedSec || 0);
    });

    for (const i of sorted) out[primaryBucket(i)].push(i);
    return out;
  }, [visible]);

  const counts = {
    needs_review: grouped.needs_review.length,
    update_requested: grouped.update_requested.length,
    active: grouped.active.length,
    approved: grouped.approved.length,
  };

  const syncLabel = useMemo(() => {
    if (!lastSync) return "—";
    const d = Math.max(0, Math.floor((Date.now() - lastSync) / 1000));
    if (d < 2) return "just now";
    return `${d}s ago`;
  }, [lastSync, loading]);

  const nextReview = grouped.needs_review[0] || null;
  const nextUpdate = grouped.update_requested[0] || null;

  const exportVisible = async () => {
    try {
      setExportingVisible(true);
      for (const i of visible) {
        try {
          await doExport(i);
        } catch (e) {
          console.error("export failed for", i.incidentId, e);
        }
      }
    } finally {
      setExportingVisible(false);
    }
  };

  // Hero card target — derived from the live incident list.
  // Preference order:
  //   1. Most recently updated accepted record that passes the
  //      smoke-artifact filter (looksRealForHero)
  //   2. Most recently updated record of any status that passes the filter
  //   3. Most recently updated accepted record from the unfiltered list
  //   4. Most recently updated record of any status (last resort)
  //   5. null → hero card hidden entirely (cold org / zero incidents)
  //
  // Accepted = status in {closed, customer_accepted}.
  const heroItem = useMemo(() => {
    const sorted = visible.slice().sort(
      (a, b) => Number(b.updatedSec || 0) - Number(a.updatedSec || 0),
    );
    const isAccepted = (i: Incident) => {
      const s = String(i.status || "").toLowerCase();
      return s === "closed" || s === "customer_accepted";
    };
    const isReal = (i: Incident) => looksRealForHero(i.title);
    return (
      sorted.find((i) => isReal(i) && isAccepted(i))
      ?? sorted.find(isReal)
      ?? sorted.find(isAccepted)
      ?? sorted[0]
      ?? null
    );
  }, [visible]);
  const heroQs = heroItem?.orgId ? `?orgId=${encodeURIComponent(heroItem.orgId)}` : "";

  return (
    <RequireAuth>
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6 gap-4">
          <div>
            {/* PEAKOPS_FRAMING_LAYER_V1 (PR 71)
                Eyebrow reframed from generic "SUPERVISOR DASHBOARD"
                to "ACCEPTANCE QUEUE" so the surface reads as the
                work-to-close-out queue, not a generic ops console.
                Subtitle reframed from "Review incidents, chase
                updates, approve records" to a proof/closeout-anchored
                three-beat. Brand-anchored "PeakOps Control Tower"
                title kept for muscle memory. */}
            <div className="text-xs tracking-[0.2em] text-gray-400">ACCEPTANCE QUEUE</div>
            <div className="text-2xl font-semibold">PeakOps Control Tower</div>
            <div className="text-sm text-gray-400">Build proof. Approve packets. Close out work.</div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] text-xs text-emerald-200">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              Auto-refresh · {syncLabel}
            </div>

            {/* PEAKOPS_DASHBOARD_DEMO_SAFE_V1
                Org filter renders only when ≥2 distinct orgs surface
                actual data. In the single-org case it's just visual
                noise. */}
            {orgs.length >= 2 ? (
              <select
                value={orgFilter}
                onChange={(e) => setOrgFilter(e.target.value)}
                className="px-3 py-2 rounded-xl bg-white/[0.05] border border-white/[0.1] text-sm"
              >
                <option value="all">All orgs</option>
                {orgs.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : null}

            {/* PEAKOPS_DASHBOARD_DEMO_SAFE_V1
                Removed the prior "Open Demo Incident" button that
                routed to the broken inc_demo / riverbend-electric
                fictional demo. The "Continue your demo" hero card
                below points at the real polished sealed incident. */}
          </div>
        </div>

        {/* Hero card. Surfaces the operator's most recently active
            accepted record, with a demo-safe filter that prefers
            real records over E2E/SMOKE/PR-named artifacts. Hidden
            entirely when the org has no incidents at all. */}
        {heroItem ? (
        <section className="mb-6 rounded-2xl border border-amber-300/20 bg-amber-500/[0.04] px-5 py-5 sm:px-6 sm:py-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
                Pick up where you left off
              </div>
              <h2 className="mt-3 text-xl sm:text-[22px] font-semibold leading-tight tracking-tight text-white truncate">
                {heroItem.title || "Untitled record"}
              </h2>
              {heroItem.location ? (
                <div className="mt-0.5 text-[12px] text-gray-300">
                  {heroItem.location}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-400">
                <span
                  className={
                    "text-[11px] px-2 py-0.5 rounded-full border " +
                    incidentStatusPill(heroItem.status)
                  }
                >
                  {incidentStatusLabel(heroItem.status)}
                </span>
                {Number.isFinite(heroItem.evidenceCount as number) ? (
                  <>
                    <span className="text-white/20">·</span>
                    <span>
                      {heroItem.evidenceCount}{" "}
                      {heroItem.evidenceCount === 1 ? "piece of evidence" : "pieces of evidence"}
                    </span>
                  </>
                ) : null}
                {heroItem.updatedAgo && heroItem.updatedAgo !== "—" ? (
                  <>
                    <span className="text-white/20">·</span>
                    <span>last activity {heroItem.updatedAgo}</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="px-3 py-1.5 rounded-xl bg-white/8 border border-white/15 text-gray-200 hover:bg-white/12 text-sm"
                onClick={() => {
                  window.location.href = `/incidents/${encodeURIComponent(heroItem.incidentId)}/review${heroQs}`;
                }}
              >
                Supervisor Review
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-xl bg-white text-black border border-white/30 hover:bg-white/90 text-sm font-medium"
                onClick={() => {
                  window.location.href = `/incidents/${encodeURIComponent(heroItem.incidentId)}/summary${heroQs}`;
                }}
              >
                Open dossier (Summary) →
              </button>
            </div>
          </div>
        </section>
        ) : null}

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {/* Lifecycle vocabulary aligned with Records chips so the
              same record cannot read as one thing here and another
              there. "Needs Review" → "In Progress"; "Approved" →
              "Accepted". Bucket math + tones unchanged. */}
          <StatCard title="In Progress" value={counts.needs_review} tone="border-blue-400/20 bg-blue-500/[0.05]" />
          {/* Total Records counts what the operator can actually see —
              i.e. items after the org filter AND the demo-hygiene
              filter (visible.length), not the raw items.length which
              still includes filtered smoke artifacts. */}
          <StatCard title="Total Records" value={visible.length} tone="border-white/[0.08] bg-white/[0.03]" />
          <StatCard title="Active" value={counts.active} tone="border-white/[0.08] bg-white/[0.03]" />
          <StatCard title="Accepted" value={counts.approved} tone="border-emerald-400/20 bg-emerald-500/[0.05]" />
        </section>

        {/* PEAKOPS_DASHBOARD_SIGNED_IN_POLISH_V1
            Hide the Operator Actions block entirely when all three
            buttons would be disabled (no review-eligible incident,
            no update-requested incident, no visible items to bulk-
            export). On the empty production state this kills the
            "three disabled buttons in a card" scaffold smell.
            Reappears automatically the moment real data flows in. */}
        {(nextReview || nextUpdate || visible.length > 0) ? (
          <section className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
            <div className="text-xs tracking-[0.16em] uppercase text-gray-500 mb-3">Operator Actions</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-blue-500/20 border border-blue-400/20 hover:bg-blue-500/30 disabled:opacity-50"
                disabled={!nextReview}
                onClick={() => {
                  if (!nextReview) return;
                  window.location.href = reviewHref(nextReview);
                }}
              >
                Review Next
              </button>

              <button
                className="px-3 py-2 rounded-xl bg-violet-500/20 border border-violet-400/20 hover:bg-violet-500/30 disabled:opacity-50"
                disabled={!nextUpdate}
                onClick={() => {
                  if (!nextUpdate) return;
                  window.location.href = incidentHref(nextUpdate);
                }}
              >
                Open Waiting on Field
              </button>

              <button
                className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/[0.1] hover:bg-white/[0.12] disabled:opacity-50"
                disabled={exportingVisible || visible.length === 0}
                onClick={() => { void exportVisible(); }}
              >
                {exportingVisible ? "Exporting visible…" : "Export Visible"}
              </button>
            </div>
          </section>
        ) : null}

        {loading ? <div className="text-gray-500 text-sm mb-4">Refreshing dashboard…</div> : null}

        {/* PEAKOPS_DASHBOARD_SIGNED_IN_POLISH_V1
            Consolidate empty-state. When all four buckets are empty
            (current production state until live data flows), render
            a single calm line instead of four repeated bucket
            sections each saying "No active incidents need attention
            right now." When any bucket has items, the individual
            sections render as before — a populated bucket carries
            its own headline + items. */}
        {visible.length === 0 ? (
          <section className="mt-8 rounded-2xl border border-white/[0.05] bg-white/[0.02] px-5 py-6 text-center">
            <div className="text-sm text-gray-300">
              No active records in supervisor review.
            </div>
            <div className="mt-1 text-[12px] text-gray-500">
              New incidents will appear here as field crews open them.
            </div>
          </section>
        ) : (
          <>
            <BucketSection title="In Progress" items={grouped.needs_review} />
            {/* Update Requested section retired alongside the matching
                tile — bucket key kept in `grouped` for downstream
                compile-safety, but the always-empty section was
                its own "misleading 0" surface. */}
            <BucketSection title="Active" items={grouped.active} />
            <BucketSection title="Accepted" items={grouped.approved} />
          </>
        )}
      </div>
    </main>
    </RequireAuth>
  );
}
