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

type Incident = {
  incidentId: string;
  orgId: string;
  status?: string;
  evidenceCount?: number;
  reviewable?: number;
  approved?: number;
  updateRequested?: boolean;
  lastEvent?: string;
  updatedAgo?: string;
  updatedSec?: number;
  latestJobTitle?: string;
  thumbUrl?: string;
};

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

function readinessChip(i: Incident): { label: string; tone: string } {
  if ((i.approved || 0) > 0) {
    return { label: "Approved", tone: "border-emerald-400/20 bg-emerald-500/10 text-emerald-200" };
  }
  if ((i.reviewable || 0) > 0) {
    return { label: "Ready for Review", tone: "border-blue-400/20 bg-blue-500/10 text-blue-200" };
  }
  if (i.updateRequested) {
    return { label: "Waiting on Field", tone: "border-violet-400/20 bg-violet-500/10 text-violet-200" };
  }
  return { label: "Active", tone: "border-white/10 bg-white/[0.05] text-gray-200" };
}

type BucketKey = "needs_review" | "update_requested" | "active" | "approved";

function primaryBucket(i: Incident): BucketKey {
  if ((i.reviewable || 0) > 0) return "needs_review";
  if (i.updateRequested) return "update_requested";
  if ((i.approved || 0) > 0) return "approved";
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

  const chip = readinessChip(i);
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
            <div className="text-lg font-semibold">{i.incidentId}</div>
            <span className={`px-2 py-1 rounded-full border text-xs ${chip.tone}`}>{chip.label}</span>
            {stale ? (
              <span className={`px-2 py-1 rounded-full border text-xs ${stale.tone}`}>{stale.label}</span>
            ) : null}
          </div>

          <div className="text-xs text-gray-400 mt-1">{i.orgId}</div>
          <div className="text-xs text-gray-500 mt-2">Latest job: {i.latestJobTitle || "—"}</div>
        </div>

        {i.updateRequested ? (
          <span className="px-2 py-1 rounded-full border border-violet-400/20 bg-violet-500/10 text-violet-200 text-xs shrink-0">
            Update Requested
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-4 mt-4">
        <div className="rounded-xl border border-white/[0.08] bg-black/20 overflow-hidden min-h-[120px] flex items-center justify-center">
          {i.thumbUrl ? (
            <img
              src={i.thumbUrl}
              alt={`${i.incidentId} evidence`}
              className="w-full h-[120px] object-cover"
            />
          ) : (
            <div className="text-xs text-gray-500">No thumbnail</div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Evidence</div>
            <div className="mt-1">{i.evidenceCount || 0}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Reviewable</div>
            <div className="mt-1">{i.reviewable || 0}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Approved</div>
            <div className="mt-1">{i.approved || 0}</div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
            <div className="text-[11px] text-gray-500 uppercase tracking-[0.16em]">Last Activity</div>
            <div className="mt-1">{humanizeEvent(i.lastEvent)}</div>
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

      <div className="text-xs text-gray-500 mt-3">updated {i.updatedAgo || "—"}</div>
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
        {items.length ? items.map((i) => <IncidentCard key={`${i.orgId}:${i.incidentId}`} i={i} />) : (
          <div className="text-gray-500 text-sm">Nothing here.</div>
        )}
      </div>
    </section>
  );
}

export default function Dashboard() {
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
    try {
      setLoading(true);
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      setItems(Array.isArray(j?.items) ? j.items : []);
      setOrgs(Array.isArray(j?.orgs) ? j.orgs : []);
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
  }, []);

  const visible = useMemo(() => {
    return items.filter((i) => orgFilter === "all" || i.orgId === orgFilter);
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

  return (
    <main className="min-h-screen bg-black text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6 gap-4">
          <div>
            <div className="text-xs tracking-[0.2em] text-gray-400">SUPERVISOR DASHBOARD</div>
            <div className="text-2xl font-semibold">PeakOps Control Tower</div>
            <div className="text-sm text-gray-400">Review incidents, chase updates, approve records.</div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] text-xs text-emerald-200">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              Live · sync {syncLabel}
            </div>

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

            <button
              className="px-3 py-2 rounded-xl bg-white/[0.05] border border-white/[0.1]"
              onClick={() => { window.location.href = "/incidents/inc_demo?orgId=riverbend-electric"; }}
            >
              Open Demo Incident
            </button>
          </div>
        </div>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard title="Needs Review" value={counts.needs_review} tone="border-blue-400/20 bg-blue-500/[0.05]" />
          <StatCard title="Update Requested" value={counts.update_requested} tone="border-violet-400/20 bg-violet-500/[0.05]" />
          <StatCard title="Active" value={counts.active} tone="border-white/[0.08] bg-white/[0.03]" />
          <StatCard title="Approved" value={counts.approved} tone="border-emerald-400/20 bg-emerald-500/[0.05]" />
        </section>

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

        {loading ? <div className="text-gray-500 text-sm mb-4">Refreshing dashboard…</div> : null}

        <BucketSection title="Needs Review" items={grouped.needs_review} />
        <BucketSection title="Update Requested" items={grouped.update_requested} />
        <BucketSection title="Active" items={grouped.active} />
        <BucketSection title="Approved" items={grouped.approved} />
      </div>
    </main>
  );
}
