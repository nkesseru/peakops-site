"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getFunctionsBase } from "@/lib/functionsBase";

type IncidentDoc = {
  id: string;
  status?: string;
  packetMeta?: {
    exportedAt?: string;
    packetHash?: string;
    sizeBytes?: number;
  };
};

type JobDoc = {
  id: string;
  jobId?: string;
  title?: string;
  status?: string;
};

type EvidenceDoc = {
  id: string;
  file?: {
    originalName?: string;
    storagePath?: string;
    bucket?: string;
    thumbPath?: string;
    previewPath?: string;
  };
  evidence?: {
    jobId?: string | null;
  };
  jobId?: string | null;
  storedAt?: { _seconds?: number };
};

type TimelineDoc = {
  id: string;
  type?: string;
  actor?: string;
  refId?: string | null;
  occurredAt?: { _seconds?: number };
};

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function statusPill(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "approved") return "bg-emerald-500/15 border-emerald-300/30 text-emerald-100";
  if (s === "rejected") return "bg-red-500/15 border-red-300/30 text-red-100";
  if (s === "complete") return "bg-indigo-500/15 border-indigo-300/30 text-indigo-100";
  if (s === "review") return "bg-amber-500/15 border-amber-300/30 text-amber-100";
  if (s === "in_progress") return "bg-sky-500/15 border-sky-300/30 text-sky-100";
  return "bg-white/8 border-white/15 text-gray-200";
}

export default function SummaryClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();
  const orgId = "riverbend-electric";

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [incident, setIncident] = useState<IncidentDoc | null>(null);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactHint, setArtifactHint] = useState("Artifact not generated yet.");
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactReady, setArtifactReady] = useState(false);

  const incidentStatus = String(incident?.status || "open");

  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {
      open: 0,
      in_progress: 0,
      complete: 0,
      review: 0,
      approved: 0,
      rejected: 0,
    };
    for (const j of jobs) {
      const s = String(j?.status || "open").toLowerCase();
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }, [jobs]);

  const evidenceByJob = useMemo(() => {
    const map: Record<string, EvidenceDoc[]> = {};
    for (const ev of evidence) {
      const jid = String(ev?.evidence?.jobId || ev?.jobId || "unassigned");
      if (!map[jid]) map[jid] = [];
      map[jid].push(ev);
    }
    return map;
  }, [evidence]);

  const timelineHighlights = useMemo(() => {
    const interesting = new Set(["job_completed", "job_approved", "job_rejected", "incident_closed", "FIELD_SUBMITTED", "EVIDENCE_ADDED"]);
    return (timeline || [])
      .filter((t) => interesting.has(String(t.type || "")))
      .slice(0, 12);
  }, [timeline]);

  async function refresh() {
    if (!functionsBase) return;
    setLoading(true);
    setErr("");
    try {
      const incUrl = `${functionsBase}/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const incRes = await fetch(incUrl);
      const incTxt = await incRes.text();
      if (!incRes.ok) throw new Error(`GET getIncidentV1 -> ${incRes.status} ${incTxt}`);
      const inc = incTxt ? JSON.parse(incTxt) : {};
      if (inc?.ok && inc.doc) setIncident(inc.doc);

      const jobsUrl = `${functionsBase}/listJobsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=100`;
      const jobsRes = await fetch(jobsUrl);
      const jobsTxt = await jobsRes.text();
      if (!jobsRes.ok) throw new Error(`GET listJobsV1 -> ${jobsRes.status} ${jobsTxt}`);
      const jb = jobsTxt ? JSON.parse(jobsTxt) : {};
      if (jb?.ok && Array.isArray(jb.docs)) setJobs(jb.docs);

      const evUrl = `${functionsBase}/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      const evRes = await fetch(evUrl);
      const evTxt = await evRes.text();
      if (!evRes.ok) throw new Error(`GET listEvidenceLocker -> ${evRes.status} ${evTxt}`);
      const ev = evTxt ? JSON.parse(evTxt) : {};
      if (ev?.ok && Array.isArray(ev.docs)) setEvidence(ev.docs);

      const tlUrl = `${functionsBase}/getTimelineEventsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      const tlRes = await fetch(tlUrl);
      const tlTxt = await tlRes.text();
      if (!tlRes.ok) throw new Error(`GET getTimelineEventsV1 -> ${tlRes.status} ${tlTxt}`);
      const tl = tlTxt ? JSON.parse(tlTxt) : {};
      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs = tl.docs.slice().sort((a: any, b: any) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0));
        setTimeline(docs);
      }

      const maybeArtifact = `${window.location.origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const head = await fetch(maybeArtifact, { method: "HEAD" }).catch(() => null);
      const hasMeta = !!String(inc?.doc?.packetMeta?.packetHash || "").trim();
      if (head && head.ok && hasMeta) {
        setArtifactUrl(maybeArtifact);
        setArtifactHint("Artifact ready.");
        setArtifactReady(true);
      } else {
        setArtifactUrl("");
        setArtifactHint("No artifact yet. Export packet first.");
        setArtifactReady(false);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function ensureArtifact() {
    if (!functionsBase || !artifactReady) return;
    try {
      setArtifactBusy(true);
      const out: any = await fetch(
        `${functionsBase}/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=summary_ui`,
        { method: "GET" }
      ).then((r) => r.json().catch(() => ({})));
      if (!out?.ok) throw new Error(out?.error || "exportIncidentPacketV1 failed");
      await refresh();
      if (artifactUrl) window.open(artifactUrl, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setArtifactBusy(false);
    }
  }

  async function prefetchThumb(ev: EvidenceDoc) {
    const id = String(ev?.id || "");
    if (!id || thumbUrl[id]) return;
    const path = String(ev?.file?.thumbPath || ev?.file?.previewPath || ev?.file?.storagePath || "");
    if (!path) return;
    try {
      const out: any = await postJson(`${functionsBase}/createEvidenceReadUrlV1`, {
        orgId,
        incidentId,
        storagePath: path,
        bucket: String(ev?.file?.bucket || "peakops-pilot.firebasestorage.app"),
        expiresSec: 900,
      });
      if (out?.ok && out?.url) setThumbUrl((m) => ({ ...m, [id]: String(out.url) }));
    } catch {}
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, functionsBase]);

  useEffect(() => {
    (evidence || []).slice(0, 40).forEach((ev) => { prefetchThumb(ev); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidence]);

  return (
    <main className="min-h-screen bg-black text-white p-4">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-400">Incident Summary</div>
            <div className="text-xl font-semibold">{incidentId}</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm hover:bg-white/10" onClick={() => router.push(`/incidents/${incidentId}`)}>
              Back
            </button>
          </div>
        </div>

        {err ? <div className="rounded-xl border border-red-400/30 bg-red-500/10 text-red-100 text-sm px-3 py-2">{err}</div> : null}

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Incident Status</div>
            <span className={"text-[11px] px-2 py-0.5 rounded-full border " + statusPill(incidentStatus)}>{incidentStatus}</span>
          </div>
          <div className="mt-3">
            <button
              type="button"
              className={"px-3 py-2 rounded-xl text-sm border " + (artifactUrl ? "bg-emerald-600/20 border-emerald-300/30 text-emerald-100 hover:bg-emerald-600/30" : "bg-white/5 border-white/10 text-gray-400")}
              disabled={artifactBusy || !artifactReady}
              onClick={() => ensureArtifact()}
              title={artifactHint}
            >
              {artifactBusy ? "Preparing Artifact..." : "Download Artifact"}
            </button>
            <div className="mt-2 text-xs text-gray-500">{artifactHint}</div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-400">Jobs Breakdown</div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {Object.entries(statusCounts).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <div className="text-[10px] uppercase text-gray-400">{k}</div>
                <div className="text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-400">Evidence by Job</div>
          <div className="mt-3 space-y-3">
            {Object.keys(evidenceByJob).length === 0 ? (
              <div className="text-sm text-gray-400">No evidence found.</div>
            ) : Object.entries(evidenceByJob).map(([jobId, list]) => {
              const job = jobs.find((j) => String(j?.id || j?.jobId || "") === jobId);
              return (
                <div key={jobId} className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-100 truncate">{job ? String(job.title || jobId) : (jobId === "unassigned" ? "Unassigned" : jobId)}</div>
                    <span className="text-xs text-gray-400">{list.length} evidence</span>
                  </div>
                  <div className="mt-2 flex gap-2 overflow-x-auto">
                    {list.slice(0, 8).map((ev) => {
                      const id = String(ev.id || "");
                      const u = thumbUrl[id];
                      return (
                        <div key={id} className="min-w-[110px] w-[110px] aspect-[4/3] rounded-lg overflow-hidden border border-white/10 bg-black">
                          {u ? (
                            <img src={u} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-500">Loading…</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-400">Timeline Highlights</div>
          <div className="mt-3 space-y-2">
            {timelineHighlights.length === 0 ? (
              <div className="text-sm text-gray-400">No highlights yet.</div>
            ) : timelineHighlights.map((t) => (
              <div key={t.id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-gray-100">{String(t.type || "event")}</div>
                  <div className="text-xs text-gray-500 truncate">
                    actor: {String(t.actor || "system")} {t.refId ? `• ref: ${String(t.refId)}` : ""}
                  </div>
                </div>
                <div className="text-xs text-gray-500">{fmtAgo(t.occurredAt?._seconds)}</div>
              </div>
            ))}
          </div>
        </section>

        {loading ? <div className="text-xs text-gray-500">Refreshing summary…</div> : null}
      </div>
    </main>
  );
}
