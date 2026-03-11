import { NextResponse } from "next/server";

type IncidentLite = {
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

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const now = Date.now() / 1000;
  const d = Math.max(0, Math.floor(now - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function thumbUrlFromEvidence(ev: any): string {
  const bucket = String(ev?.bucket || ev?.file?.bucket || "").trim();
  const storagePath = String(
    ev?.thumbPath ||
    ev?.file?.thumbPath ||
    ev?.file?.derivatives?.thumb?.storagePath ||
    ev?.previewPath ||
    ev?.file?.previewPath ||
    ev?.file?.derivatives?.preview?.storagePath ||
    ev?.storagePath ||
    ev?.file?.storagePath ||
    ""
  ).trim();

  if (bucket && storagePath) {
    return `/api/media?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(storagePath)}`;
  }
  return String(ev?.url || "").trim();
}

export async function GET() {
  try {
    const base = "http://127.0.0.1:3001";

    const seeds = [
      { incidentId: "inc_demo", orgId: "riverbend-electric" },
      { incidentId: "inc_substation", orgId: "riverbend-electric" },
      { incidentId: "inc_celltower", orgId: "northwind-telecom" },
      { incidentId: "inc_fiber_cut", orgId: "northwind-telecom" },
      { incidentId: "inc_water_main", orgId: "spokane-valley-utilities" },
      { incidentId: "inc_transformer", orgId: "spokane-valley-utilities" },
    ];

    const items: IncidentLite[] = [];

    for (const s of seeds) {
      const [incRes, evRes, jobsRes, tlRes] = await Promise.all([
        fetch(`${base}/api/fn/getIncidentV1?orgId=${encodeURIComponent(s.orgId)}&incidentId=${encodeURIComponent(s.incidentId)}`, { cache: "no-store" }),
        fetch(`${base}/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(s.orgId)}&incidentId=${encodeURIComponent(s.incidentId)}&limit=200`, { cache: "no-store" }),
        fetch(`${base}/api/fn/listJobsV1?orgId=${encodeURIComponent(s.orgId)}&incidentId=${encodeURIComponent(s.incidentId)}&limit=100&actorUid=dev-admin&actorRole=admin`, { cache: "no-store" }),
        fetch(`${base}/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(s.orgId)}&incidentId=${encodeURIComponent(s.incidentId)}&limit=100`, { cache: "no-store" }),
      ]);

      const inc = await incRes.json().catch(() => ({}));
      const ev = await evRes.json().catch(() => ({}));
      const jobs = await jobsRes.json().catch(() => ({}));
      const tl = await tlRes.json().catch(() => ({}));

      const incOk = incRes.ok && (inc?.ok !== false);
      const evDocs = Array.isArray(ev?.docs) ? ev.docs : [];
      const jobDocs = Array.isArray(jobs?.docs) ? jobs.docs : [];
      const tlDocs = Array.isArray(tl?.docs) ? tl.docs : [];

      if (!incOk && evDocs.length === 0 && jobDocs.length === 0 && tlDocs.length === 0) {
        continue;
      }

      const reviewable = jobDocs.filter((j: any) => {
        const st = String(j?.status || "").toLowerCase();
        return st === "complete" || st === "review";
      }).length;

      const approved = jobDocs.filter((j: any) => {
        const st = String(j?.status || "").toLowerCase();
        return st === "approved";
      }).length;

      const latestTl = tlDocs.slice().sort((a: any, b: any) => {
        const aSec = Number(a?.occurredAt?._seconds || 0);
        const bSec = Number(b?.occurredAt?._seconds || 0);
        return bSec - aSec;
      })[0];

      const latestJob = jobDocs.slice().sort((a: any, b: any) => {
        const aSec = Number(a?.updatedAt?._seconds || a?.createdAt?._seconds || 0);
        const bSec = Number(b?.updatedAt?._seconds || b?.createdAt?._seconds || 0);
        return bSec - aSec;
      })[0];

      const latestEvidence = evDocs.slice().sort((a: any, b: any) => {
        const aSec = Number(a?.storedAt?._seconds || a?.createdAt?._seconds || 0);
        const bSec = Number(b?.storedAt?._seconds || b?.createdAt?._seconds || 0);
        return bSec - aSec;
      })[0];

      const latestRequestUpdate = tlDocs
        .filter((t: any) => String(t?.type || "").toUpperCase() === "SUPERVISOR_REQUEST_UPDATE")
        .sort((a: any, b: any) => Number(b?.occurredAt?._seconds || 0) - Number(a?.occurredAt?._seconds || 0))[0];

      const latestFieldResponse = tlDocs
        .filter((t: any) => {
          const ty = String(t?.type || "").toUpperCase();
          return ty === "EVIDENCE_ADDED" || ty === "NOTES_SAVED" || ty === "FIELD_ARRIVED" || ty === "JOB_COMPLETED";
        })
        .sort((a: any, b: any) => Number(b?.occurredAt?._seconds || 0) - Number(a?.occurredAt?._seconds || 0))[0];

      const requestSec = Number(latestRequestUpdate?.occurredAt?._seconds || 0);
      const responseSec = Number(latestFieldResponse?.occurredAt?._seconds || 0);

      const updateRequested = !!latestRequestUpdate && responseSec < requestSec;

      const updatedSec =
        Number(
          inc?.updatedAt?._seconds ||
          inc?.createdAt?._seconds ||
          latestTl?.occurredAt?._seconds ||
          latestJob?.updatedAt?._seconds ||
          latestEvidence?.storedAt?._seconds ||
          0
        );

      items.push({
        incidentId: s.incidentId,
        orgId: s.orgId,
        status: String(inc?.incidentStatus || inc?.status || "open"),
        evidenceCount: evDocs.length,
        reviewable,
        approved,
        updateRequested,
        lastEvent: String(latestTl?.type || "—"),
        updatedAgo: fmtAgo(updatedSec),
        updatedSec,
        latestJobTitle: String(latestJob?.title || ""),
        thumbUrl: latestEvidence ? thumbUrlFromEvidence(latestEvidence) : "",
      });
    }

    const orgs = Array.from(new Set(items.map((i) => i.orgId))).sort();

    return NextResponse.json({ ok: true, items, orgs });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e || "dashboard route failed"), items: [], orgs: [] },
      { status: 500 }
    );
  }
}
