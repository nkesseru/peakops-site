// src/app/admin/stormwatch/page.tsx
import Link from "next/link";
import { getAdminDb } from "@/lib/firebaseAdmin";

export const dynamic = "force-dynamic";

type OrgHealthStatus = "OK" | "WARN" | "CRITICAL";

type OrgHealthView = {
  orgId: string;
  health: OrgHealthStatus;
  openIssuesCount: number;
  criticalIssuesCount: number;
  lastEventAt?: string | null;
};

type EventView = {
  id: string;
  orgId: string;
  type: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  message: string;
  createdAt: string;
  objectType?: string | null;
  objectId?: string | null;
};

const healthRank: Record<OrgHealthStatus, number> = {
  CRITICAL: 0,
  WARN: 1,
  OK: 2,
};

function formatTs(ts: any): string {
  if (!ts) return "";
  try {
    // Firestore Timestamp has toDate()
    const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function healthBadgeClass(status: OrgHealthStatus) {
  switch (status) {
    case "CRITICAL":
      return "bg-red-600 text-white";
    case "WARN":
      return "bg-amber-500 text-black";
    case "OK":
    default:
      return "bg-emerald-600 text-white";
  }
}

export default async function StormwatchPage({
  searchParams,
}: {
  searchParams?: { org?: string };
}) {
  const selectedOrgId = searchParams?.org || "";

  const db = getAdminDb();

  const [orgHealthSnap, eventsSnap] = await Promise.all([
    db.collection("org_health_views").get(),
    db
      .collection("customer_events")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get(),
  ]);

  const orgHealth: OrgHealthView[] = orgHealthSnap.docs.map((doc) => {
    const data = doc.data() as any;
    return {
      orgId: data.orgId ?? doc.id,
      health: (data.health ?? "OK") as OrgHealthStatus,
      openIssuesCount: data.openIssuesCount ?? 0,
      criticalIssuesCount: data.criticalIssuesCount ?? 0,
      lastEventAt: formatTs(data.lastEventAt),
    };
  });

  // Sort by severity, then by open issues
  orgHealth.sort((a, b) => {
    const byHealth = healthRank[a.health] - healthRank[b.health];
    if (byHealth !== 0) return byHealth;
    return (b.openIssuesCount ?? 0) - (a.openIssuesCount ?? 0);
  });

  let events: EventView[] = eventsSnap.docs.map((doc) => {
    const data = doc.data() as any;
    return {
      id: doc.id,
      orgId: data.orgId ?? "",
      type: data.type ?? "",
      severity: (data.severity ?? "INFO") as "INFO" | "WARN" | "CRITICAL",
      message: data.message ?? "",
      createdAt: formatTs(data.createdAt),
      objectType: data.objectType ?? null,
      objectId: data.objectId ?? null,
    };
  });

  if (selectedOrgId) {
    events = events.filter((e) => e.orgId === selectedOrgId);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 lg:flex-row">
        {/* LEFT: Org health table */}
        <section className="w-full lg:w-1/3">
          <h1 className="mb-4 text-xl font-semibold tracking-tight text-slate-100">
            Stormwatch – Customers
          </h1>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 shadow-xl">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/80">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-300">
                    Org
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-slate-300">
                    Health
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-slate-300">
                    Issues
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {orgHealth.map((org) => (
                  <tr
                    key={org.orgId}
                    className={
                      selectedOrgId === org.orgId
                        ? "bg-slate-800/70"
                        : "hover:bg-slate-800/40"
                    }
                  >
                    <td className="px-4 py-3 align-top">
                      <Link
                        href={
                          org.orgId === selectedOrgId
                            ? "/admin/stormwatch"
                            : `/admin/stormwatch?org=${encodeURIComponent(
                                org.orgId
                              )}`
                        }
                        className="block"
                      >
                        <div className="text-sm font-medium text-slate-50">
                          {org.orgId}
                        </div>
                        {org.lastEventAt && (
                          <div className="mt-0.5 text-xs text-slate-400">
                            Last event: {org.lastEventAt}
                          </div>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${healthBadgeClass(
                          org.health
                        )}`}
                      >
                        {org.health}
                      </span>
                    </td>
                    <td className="px-3 py-3 pr-4 text-right align-top text-xs text-slate-300">
                      <div>{org.openIssuesCount ?? 0} open</div>
                      {org.criticalIssuesCount > 0 && (
                        <div className="mt-0.5 text-red-400">
                          {org.criticalIssuesCount} critical
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {orgHealth.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-6 text-center text-sm text-slate-400"
                    >
                      No org health data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* RIGHT: Events feed */}
        <section className="w-full lg:w-2/3 space-y-4">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">
                {selectedOrgId
                  ? `Events for ${selectedOrgId}`
                  : "Recent Stormwatch Events"}
              </h2>
              <p className="text-xs text-slate-400">
                Showing latest {events.length} events
                {selectedOrgId && " (filtered by org)"}.
              </p>
            </div>
            {selectedOrgId && (
              <Link
                href="/admin/stormwatch"
                className="text-xs font-medium text-slate-300 hover:text-slate-100"
              >
                Clear filter
              </Link>
            )}
          </header>

          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 shadow-xl">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/80">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-300">
                    When
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-slate-300">
                    Org
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-slate-300">
                    Type
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-slate-300">
                    Severity
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-300">
                    Message
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {events.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-800/40">
                    <td className="px-4 py-3 align-top text-xs text-slate-400">
                      {e.createdAt}
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-slate-200">
                      {e.orgId}
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-slate-300">
                      {e.type}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${
                          e.severity === "CRITICAL"
                            ? "bg-red-600/80 text-white"
                            : e.severity === "WARN"
                            ? "bg-amber-500/80 text-black"
                            : "bg-slate-600/80 text-slate-50"
                        }`}
                      >
                        {e.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-slate-100">
                      <div>{e.message}</div>
                      {e.objectType === "job" && e.objectId && (
                        <div className="mt-1 text-[0.65rem] text-slate-400">
                          Job:{" "}
                          <span className="font-mono">{e.objectId}</span>{" "}
                          {/* TODO: link to job detail route when ready */}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-sm text-slate-400"
                    >
                      No events yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
