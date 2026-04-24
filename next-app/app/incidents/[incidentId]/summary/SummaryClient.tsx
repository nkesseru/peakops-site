"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  clearRememberedFunctionsBase,
  getEnvFunctionsBase,
  getFunctionsBase,
  getFunctionsBaseDebugInfo,
  getFunctionsBaseFallback,
  isLikelyFetchNetworkError,
  probeAndRestoreEnvFunctionsBase,
  rememberFunctionsBase,
  warnFunctionsBaseIfSuspicious,
} from "@/lib/functionsBase";
import { ensureDemoActor, getActorRole, getActorUid, isDemoIncident } from "@/lib/demoActor";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { normalizeIncidentStatusShared, incidentStatusLabel, incidentStatusPill } from "@/lib/incidents/incidentStatus";
import { incidentPath } from "@/lib/navigation/incidentRoutes";

type IncidentDoc = {
  id: string;
  status?: string;
  packetMeta?: {
    status?: string;
    exportedAt?: string;
    packetHash?: string;
    sizeBytes?: number;
    evidenceCount?: number;
    jobCount?: number;
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

function getEvidenceJobId(ev: EvidenceDoc): string {
  const top = String((ev as any)?.jobId || (ev as any)?.["jobId"] || "").trim();
  if (top) return top;
  const nested = String((ev as any)?.evidence?.jobId || (ev as any)?.["evidence.jobId"] || "").trim();
  if (nested) return nested;
  const nestedJob = String((ev as any)?.job?.jobId || (ev as any)?.["job.jobId"] || "").trim();
  return nestedJob;
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export default function SummaryClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();
  useEffect(() => {
    warnFunctionsBaseIfSuspicious(functionsBase);
  }, [functionsBase]);
  // PEAKOPS_SUMMARY_ORGID_URL_V1
  // orgId is URL-sourced, matching IncidentClient/ReviewClient/NotesClient and
  // the single-source-of-truth rule for this app. No hardcoded fallback — if
  // the URL has no ?orgId=, every downstream fetch targets an empty orgId and
  // the backend surfaces a clear 400/409 instead of the old silent cross-org
  // mis-fetch against "riverbend-electric".
  const _summarySp = useSearchParams();
  const orgId = String(_summarySp?.get?.("orgId") || "").trim();
  const functionsBaseIsLocal = useMemo(() => {
    try {
      const host = String(new URL(String(functionsBase || "")).hostname || "").toLowerCase();
      return host === "127.0.0.1" || host === "localhost";
    } catch {
      return false;
    }
  }, [functionsBase]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errUrl, setErrUrl] = useState("");
  const [errStatus, setErrStatus] = useState<number | null>(null);
  const [errBody, setErrBody] = useState("");
  const [incident, setIncident] = useState<IncidentDoc | null>(null);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbErrById, setThumbErrById] = useState<Record<string, string>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbMintErrorById, setThumbMintErrorById] = useState<Record<string, string>>({});
  const [thumbProbeStatusById, setThumbProbeStatusById] = useState<Record<string, number>>({});
  const [thumbProbeErrorById, setThumbProbeErrorById] = useState<Record<string, string>>({});
  const [thumbPathById, setThumbPathById] = useState<Record<string, string>>({});
  const [thumbBucketById, setThumbBucketById] = useState<Record<string, string>>({});
  const [thumbDebugOverlay, setThumbDebugOverlay] = useState(false);
  const thumbRefreshInflightRef = useRef<Record<string, boolean>>({});
  const thumbRefreshDebounceRef = useRef<any>(null);
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [fixUnassignedBusy, setFixUnassignedBusy] = useState(false);
  const [artifactHint, setArtifactHint] = useState("Artifact not generated yet.");
  const [artifactToast, setArtifactToast] = useState("");
  const [lastArtifactFilename, setLastArtifactFilename] = useState("");
  const [lastArtifactAt, setLastArtifactAt] = useState("");
  // PEAKOPS_SUMMARY_ARTIFACT_REUSE_V1 (2026-04-24)
  // Read states surface the "ready + URL" signal to handleArtifactDownload,
  // so the button can short-circuit to a direct download instead of
  // re-invoking exportIncidentPacketV1 when the packet already exists.
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactReady, setArtifactReady] = useState(false);
  const isDemoMode = isDemoIncident(incidentId);
  const [demoAuthBypassMsg, setDemoAuthBypassMsg] = useState("");
  const [activeOrgId, setActiveOrgId] = useState(orgId);
  const demoHeaders = useMemo(() => {
    try {
      const demoMode = String(localStorage.getItem("peakops_demo_mode") || "") === "1";
      const looksDemoIncident = /^inc_/i.test(String(incidentId || ""));
      if (functionsBaseIsLocal && (demoMode || looksDemoIncident)) return { "x-peakops-demo": "1" };
    } catch {}
    return {} as Record<string, string>;
  }, [functionsBaseIsLocal, incidentId]);

  const incidentStatus = normalizeIncidentStatusShared(incident?.status);
  const packetEvidenceCount = evidence.length;
  const packetJobCount = jobs.length;


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
      const jid = String(getEvidenceJobId(ev) || "unassigned");
      if (!map[jid]) map[jid] = [];
      map[jid].push(ev);
    }
    return map;
  }, [evidence]);
  const unassignedEvidenceCount = useMemo(
    () => (evidence || []).filter((ev) => !getEvidenceJobId(ev)).length,
    [evidence]
  );

  const liveEvidenceCount = Array.isArray(evidence) ? evidence.length : 0;
  const liveJobsCount = Array.isArray(jobs) ? jobs.length : 0;

  const timelineHighlights = useMemo(() => {
    const interesting = new Set(["job_completed", "job_approved", "job_rejected", "incident_closed", "field_submitted", "evidence_added"]);
    return (timeline || [])
      .filter((t) => {
        const ty = String(t.type || "").toLowerCase();
        return interesting.has(ty);
      })
      .slice(0, 50);
  }, [timeline]);

  async function refresh(retryAttempt = 0, baseOverride?: string, fallbackUsed = false) {
    const base = String(baseOverride || functionsBase || "").trim();
    if (!base) return;
    setLoading(true);
    setErr("");
    setErrUrl("");
    setErrStatus(null);
    setErrBody("");
    setDemoAuthBypassMsg("");
    try {
      let requestOrgId = String(activeOrgId || orgId || "").trim() || orgId;
      if (isDemoMode || functionsBaseIsLocal) {
        ensureDemoActor(incidentId);
      }
      const throwHttp = (name: string, url: string, status: number, body: string) => {
        const e: any = new Error(`${name} failed (${status})`);
        e.endpoint = url;
        e.status = status;
        e.body = String(body || "").slice(0, 500);
        throw e;
      };
      const incUrl = `/api/fn/getIncidentV1?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      setErrUrl(incUrl);
      const incRes = await fetch(incUrl, { headers: demoHeaders });
      const incTxt = await incRes.text();
      if (!incRes.ok) {
        throwHttp("getIncidentV1", incUrl, incRes.status, incTxt);
      }
      const inc = incTxt ? JSON.parse(incTxt) : {};
      if (inc?.ok && inc.doc) {
        setIncident(inc.doc);
        const nextOrg = String(inc?.doc?.orgId || "").trim();
        if (nextOrg) {
          requestOrgId = nextOrg;
          setActiveOrgId(nextOrg);
        }
      }

      const jobsUrl =
        `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=100` +
        `&actorUid=${encodeURIComponent(getActorUid())}` +
        `&actorRole=${encodeURIComponent(getActorRole())}`;
      setErrUrl(jobsUrl);
      const jobsRes = await fetch(jobsUrl, { headers: demoHeaders });
      const jobsTxt = await jobsRes.text();
      if (!jobsRes.ok) {
        if ((isDemoMode || functionsBaseIsLocal) && jobsRes.status === 403 && jobsTxt.includes("auth_required")) {
          setDemoAuthBypassMsg("Demo auth bypass failed for listJobsV1. Ensure demo actor is set (peakops_uid/peakops_role) and refresh.");
        }
        throwHttp("listJobsV1", jobsUrl, jobsRes.status, jobsTxt);
      }
      const jb = jobsTxt ? JSON.parse(jobsTxt) : {};
      if (jb?.ok && Array.isArray(jb.docs)) setJobs(jb.docs);

      const evUrl = `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      setErrUrl(evUrl);
      const evRes = await fetch(evUrl, { headers: demoHeaders });
      const evTxt = await evRes.text();
      if (!evRes.ok) {
        throwHttp("listEvidenceLocker", evUrl, evRes.status, evTxt);
      }
      const ev = evTxt ? JSON.parse(evTxt) : {};
      if (ev?.ok && Array.isArray(ev.docs)) setEvidence(ev.docs);

      const tlUrl = `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      setErrUrl(tlUrl);
      const tlRes = await fetch(tlUrl, { headers: demoHeaders });
      const tlTxt = await tlRes.text();
      if (!tlRes.ok) {
        throwHttp("getTimelineEventsV1", tlUrl, tlRes.status, tlTxt);
      }
      const tl = tlTxt ? JSON.parse(tlTxt) : {};
      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs = tl.docs.slice().sort((a: any, b: any) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0));
        setTimeline(docs);
      }

      const packetMeta: any = inc?.doc?.packetMeta || {};
      const packetStatus = String(packetMeta?.status || "").toLowerCase();
      const packetBucket = String(packetMeta?.bucket || packetMeta?.packetBucket || "").trim();
      const packetStoragePath = String(packetMeta?.storagePath || packetMeta?.packetStoragePath || "").trim();
      const packetDownloadUrl = String(packetMeta?.downloadUrl || "").trim();

      let maybeArtifact = "";
      if (packetDownloadUrl) {
        maybeArtifact = packetDownloadUrl;
      } else if (packetBucket && packetStoragePath) {
        maybeArtifact =
          `/api/media?bucket=${encodeURIComponent(packetBucket)}` +
          `&path=${encodeURIComponent(packetStoragePath)}&download=1`;
      } else {
        maybeArtifact =
          `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
      }

      if (packetStatus === "ready" && maybeArtifact) {
        setArtifactUrl(maybeArtifact);
        setArtifactHint("Artifact ready to download.");
        setArtifactReady(true);
      } else if (packetStatus === "building") {
        setArtifactUrl("");
        setArtifactHint("Artifact is building. Try again shortly.");
        setArtifactReady(false);
      } else {
        setArtifactUrl("");
        setArtifactHint("No artifact yet. Click Artifact to generate it.");
        setArtifactReady(false);
      }
      setErrUrl("");
    } catch (e: any) {
      const msg = String(e?.message || e || "refresh_failed");
      const status = Number(e?.status || 0) || null;
      const endpoint = String(e?.endpoint || errUrl || "");
      const body = String(e?.body || "").slice(0, 500);
      const isNetworkFailure = isLikelyFetchNetworkError(e, status || undefined);
      if (isNetworkFailure && retryAttempt < 1) {
        const fallbackBase = getFunctionsBaseFallback(base);
        if (fallbackBase) void rememberFunctionsBase(fallbackBase);
        if (fallbackBase) {
          probeAndRestoreEnvFunctionsBase(fallbackBase);
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("[summary-refresh] transient network failure, retrying once", {
            incidentId,
            endpoint,
            message: msg,
            attempt: retryAttempt + 1,
            base,
            fallbackBase: fallbackBase || "",
          });
        }
        if (fallbackBase) {
          setTimeout(() => { void refresh(retryAttempt + 1, fallbackBase, true); }, 500);
          return;
        }
        setTimeout(() => { void refresh(retryAttempt + 1, base, fallbackUsed); }, 500);
        return;
      }
      if ((isDemoMode || functionsBaseIsLocal) && msg.includes("auth_required")) {
        setErr("");
      } else {
        setErr(msg);
      }
      setErrUrl(endpoint || base);
      setErrStatus(status);
      setErrBody(body || `functionsBase=${base}${fallbackUsed ? " fallback=applied" : ""}`);
    } finally {
      setLoading(false);
    }
  }
  async function handleArtifactDownload() {
    if (!activeOrgId || !incidentId) {
      setErr("Cannot generate artifact: missing org or incident context.");
      return;
    }

    // PEAKOPS_SUMMARY_ARTIFACT_REUSE_V1 (2026-04-24)
    // If the packet is already ready, download the existing artifact
    // rather than POSTing exportIncidentPacketV1 again. Prevents
    // duplicate regenerations (which would change the zip hash) and
    // duplicate billable invocations.
    if (artifactReady && artifactUrl) {
      const existingName =
        lastArtifactFilename || `incident_${incidentId}_packet.zip`;
      const a = document.createElement("a");
      a.href = artifactUrl;
      a.download = existingName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setArtifactToast(`Artifact already generated — downloaded ${existingName}.`);
      window.setTimeout(() => setArtifactToast(""), 2500);
      return;
    }

    setArtifactBusy(true);
    setArtifactToast("");
    setErr("");

    try {
      const exportRes = await fetch("/api/fn/exportIncidentPacketV1", {
        method: "POST",
        headers: { "content-type": "application/json", ...demoHeaders },
        body: JSON.stringify({
          orgId: activeOrgId,
          incidentId,
          requestedBy: getActorUid?.() || "summary_ui",
          actorUid: getActorUid?.() || "summary_ui",
          actorRole: getActorRole?.() || "admin",
        }),
      });

      const exportTxt = await exportRes.text();
      const out = exportTxt ? JSON.parse(exportTxt) : {};

      // PEAKOPS_SUMMARY_ARTIFACT_409_V1 (2026-04-24)
      // A 409 response paired with an incident that already has a ready
      // packet means the backend rejected regeneration because the
      // artifact exists. Treat it as a success state: show a friendly
      // toast and let the next refresh() pick up the existing packet
      // URL, rather than surfacing a red error to the operator.
      const packetAlreadyReady =
        artifactReady ||
        String((incident as any)?.packetMeta?.status || "").toLowerCase() === "ready";
      if (exportRes.status === 409 && packetAlreadyReady) {
        setArtifactToast("Artifact already generated.");
        window.setTimeout(() => setArtifactToast(""), 2500);
        setTimeout(() => {
          void refresh().catch(() => {});
        }, 300);
        return;
      }

      if (!exportRes.ok || !out?.ok) {
        throw new Error(out?.error || `exportIncidentPacketV1 failed (${exportRes.status})`);
      }

      const bucket = String(
        out?.bucket ||
        out?.packetBucket ||
        out?.packetMeta?.bucket ||
        out?.packetMeta?.packetBucket ||
        ""
      ).trim();

      const storagePath = String(
        out?.storagePath ||
        out?.packetStoragePath ||
        out?.packetMeta?.storagePath ||
        out?.packetMeta?.packetStoragePath ||
        ""
      ).trim();

      const directUrl = String(
        out?.downloadUrl ||
        out?.packetMeta?.downloadUrl ||
        ""
      ).trim();

      const filename =
        String(out?.filename || "").trim() ||
        (storagePath ? String(storagePath).split("/").pop() || "" : "") ||
        `incident_${incidentId}_packet.zip`;

      let href = directUrl;
      if (!href && bucket && storagePath) {
        href =
          `/api/media?bucket=${encodeURIComponent(bucket)}` +
          `&path=${encodeURIComponent(storagePath)}&download=1`;
      }
      if (!href) {
        href =
          `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(activeOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
      }

      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setArtifactUrl(href);
      setArtifactReady(true);
      setLastArtifactFilename(filename);
      setLastArtifactAt(new Date().toLocaleString());
      setArtifactHint("Artifact ready to download.");
      setArtifactToast(`Artifact downloaded: ${filename}`);

      setTimeout(() => {
        void refresh().catch(() => {});
      }, 600);
    } catch (e: any) {
      setErr(String(e?.message || e || "artifact download failed"));
    } finally {
      setArtifactBusy(false);
    }
  }

  async function ensureArtifact() {
    const requestOrgId = String(orgId || "").trim();
    if (!requestOrgId || !incidentId || err) return;
    try {
      setArtifactBusy(true);
      const res = await fetch("/api/fn/exportIncidentArtifactV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: requestOrgId, incidentId }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) throw new Error(out?.error || `exportIncidentArtifactV1 failed (${res.status})`);
      const filename = String(out?.filename || `incident_${incidentId}.zip`);
      const base64Zip = String(out?.base64Zip || "");
      if (!base64Zip) throw new Error("base64_zip_missing");
      const bin = atob(base64Zip);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLastArtifactFilename(filename);
      setLastArtifactAt(new Date().toISOString());
      setArtifactToast(`Artifact downloaded: ${filename}`);
      window.setTimeout(() => setArtifactToast(""), 2500);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setArtifactBusy(false);
    }
  }

  async function fixUnassignedEvidence() {
    if (!(isDemoMode || process.env.NODE_ENV !== "production")) return;
    try {
      setFixUnassignedBusy(true);
      const unresolved = (evidence || []).filter((ev) => !getEvidenceJobId(ev));
      if (unresolved.length < 1) {
        setArtifactToast("No unassigned evidence found.");
        window.setTimeout(() => setArtifactToast(""), 2000);
        return;
      }
      let fixed = 0;
      for (const ev of unresolved) {
        const evidenceId = String((ev as any)?.id || "").trim();
        if (!evidenceId) continue;
        const nested = String((ev as any)?.evidence?.jobId || (ev as any)?.["evidence.jobId"] || "").trim();
        const targetJobId = nested || "job_demo_002";
        const res = await fetch("/api/fn/assignEvidenceToJobV1", {
          method: "POST",
          headers: { "content-type": "application/json", ...demoHeaders },
          body: JSON.stringify({
            orgId: activeOrgId || orgId,
            incidentId,
            evidenceId,
            jobId: targetJobId,
          }),
        });
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok || !out?.ok) {
          throw new Error(String(out?.error || `assignEvidenceToJobV1 failed (${res.status})`));
        }
        fixed += 1;
      }
      setArtifactToast(`Fixed ${fixed} unassigned evidence item${fixed === 1 ? "" : "s"}.`);
      window.setTimeout(() => setArtifactToast(""), 2500);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setFixUnassignedBusy(false);
    }
  }

  async function prefetchThumb(ev: EvidenceDoc) {
    const id = String(ev?.id || "");
    if (!id || thumbUrl[id]) return;
    const ref = getBestEvidencePreviewRef(ev);
    if (!ref?.storagePath || !ref?.bucket) return;
    try {
      const out = await mintEvidenceReadUrl({
        orgId: activeOrgId || orgId,
        incidentId,
        storagePath: ref.storagePath,
        bucket: ref.bucket,
        expiresSec: getThumbExpiresSec(),
      }, demoHeaders);
      if (out?.ok && out?.url) {
        setThumbUrl((m) => ({ ...m, [id]: String(out.url) }));
        setThumbPathById((m) => ({ ...m, [id]: String(ref.storagePath) }));
        setThumbBucketById((m) => ({ ...m, [id]: String(ref.bucket) }));
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErrById((m) => {
          if (!m[id]) return m;
          const n = { ...m };
          delete n[id];
          return n;
        });
        setThumbStatusById((m) => ({ ...m, [id]: Number(out.status || 200) }));
        setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
        setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
        setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      }
    } catch (e: any) {
      setThumbErrById((m) => ({ ...m, [id]: String(e?.message || e || "thumb_prefetch_failed") }));
      setThumbStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbMintErrorById((m) => ({ ...m, [id]: String(e?.message || e || "thumb_prefetch_failed") }));
    }
  }

  async function renewThumbOnce(ev: EvidenceDoc, currentSrc: string) {
    const id = String(ev?.id || "");
    if (!id) return;
    if (functionsBaseIsLocal) {
      // Emulator mode: disable auto-renew/retry to avoid flicker loops.
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      return;
    }
    const retryN = Number(thumbRetryById[id] || 0);
    if (retryN >= 1) {
      setThumbErrById((m) => ({ ...m, [id]: m[id] || "read_url_failed" }));
      return;
    }
    const ref = getBestEvidencePreviewRef(ev);
    if (!ref?.storagePath || !ref?.bucket) {
      setThumbErrById((m) => ({ ...m, [id]: "missing_bucket_or_storagePath" }));
      return;
    }
    setThumbRetryById((m) => ({ ...m, [id]: retryN + 1 }));
    if (process.env.NODE_ENV !== "production") {
      logThumbEvent("img_error", {
        evidenceId: id,
        kind: ref.kind,
        bucket: ref.bucket,
        storagePath: ref.storagePath,
        src: currentSrc,
        retryCount: retryN,
      });
    }
    logThumbEvent("retry_start", { evidenceId: id, kind: ref.kind, storagePath: ref.storagePath, retryCount: retryN });
    const out = await mintEvidenceReadUrl({
      orgId: activeOrgId || orgId,
      incidentId,
      storagePath: ref.storagePath,
      bucket: ref.bucket,
      expiresSec: getThumbExpiresSec(),
    }, demoHeaders);
    if (out?.ok && out.url) {
      const sep = out.url.includes("?") ? "&" : "?";
      const fresh = `${out.url}${sep}v=${Date.now()}`;
      setThumbUrl((m) => ({ ...m, [id]: fresh }));
      setThumbPathById((m) => ({ ...m, [id]: String(ref.storagePath) }));
      setThumbBucketById((m) => ({ ...m, [id]: String(ref.bucket) }));
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      setThumbErrById((m) => {
        if (!m[id]) return m;
        const n = { ...m };
        delete n[id];
        return n;
      });
      setThumbStatusById((m) => ({ ...m, [id]: Number(out.status || 200) }));
      setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
      setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      if (!functionsBaseIsLocal) {
        void probeMintedThumbUrl(fresh).then((probe) => {
          const pmsg = probe.ok ? "" : (probe.status > 0 ? `probe_http_${probe.status}` : String(probe.error || "probe_failed"));
          setThumbProbeStatusById((m) => ({ ...m, [id]: Number(probe.status || 0) }));
          setThumbProbeErrorById((m) => ({ ...m, [id]: pmsg || "-" }));
        });
      }
      logThumbEvent("retry_ok", { evidenceId: id, kind: ref.kind, storagePath: ref.storagePath });
      return;
    }
    const mintErr = String(out?.error || "read_url_failed");
    const mintDetails = out?.details ? String(JSON.stringify(out.details)).slice(0, 180) : "";
    const mintStatus = Number(out?.mintHttp || out?.status || 0) || 0;
    const showFail = retryN >= 1;
    setThumbErrById((m) => ({
      ...m,
      [id]: `${showFail ? "" : "retrying:"}mint_http=${mintStatus} mint_error=${mintErr}${mintDetails ? `:${mintDetails}` : ""} probe_http=- probe_error=-`,
    }));
    setThumbStatusById((m) => ({ ...m, [id]: Number(out?.status || 0) }));
    setThumbMintErrorById((m) => ({ ...m, [id]: `${mintErr}${mintDetails ? `:${mintDetails}` : ""}` }));
    setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
    setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
    logThumbEvent("retry_fail", {
      evidenceId: id,
      kind: ref.kind,
      storagePath: ref.storagePath,
      status: Number(out?.status || 0),
      error: String(out?.error || "read_url_failed"),
    });
  }

  useEffect(() => {
    ensureDemoActor(incidentId);
  }, [incidentId]);

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

  function refreshVisibleThumbsDebounced() {
    if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    thumbRefreshDebounceRef.current = setTimeout(() => {
      const ids = new Set<string>();
      Object.values(evidenceByJob).forEach((list) => list.slice(0, 8).forEach((ev) => ids.add(String(ev?.id || ""))));
      for (const id of ids) {
        if (!id || thumbRefreshInflightRef.current[id]) continue;
        const ev = (evidence || []).find((x: any) => String(x?.id || "") === id);
        if (!ev) continue;
        thumbRefreshInflightRef.current[id] = true;
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErrById((m) => ({ ...m, [id]: "" }));
        const current = String(thumbUrl[id] || "");
        void renewThumbOnce(ev, current).finally(() => {
          thumbRefreshInflightRef.current[id] = false;
        });
      }
    }, 120);
  }

  function forceRemintVisibleThumbs() {
    setThumbUrl({});
    setThumbRetryById({});
    setThumbErrById({});
    setThumbStatusById({});
    setThumbMintErrorById({});
    setThumbProbeStatusById({});
    setThumbProbeErrorById({});
    setThumbPathById({});
    setThumbBucketById({});
    refreshVisibleThumbsDebounced();
  }

  useEffect(() => {
    return () => {
      if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    };
  }, []);


  const truthMismatchReasons = useMemo(() => {
    const reasons: string[] = [];

    const packetMeta: any = (incident as any)?.packetMeta || {};
    const packetJobCount = Number(packetMeta?.jobCount || 0);
    const packetEvidenceCount = Number(packetMeta?.evidenceCount || 0);

    const approvedJobs = (Array.isArray(jobs) ? jobs : []).filter((j: any) => {
      const rs = String(j?.reviewStatus || "").toLowerCase();
      const st = String(j?.status || "").toLowerCase();
      return rs === "approved" || st === "approved";
    });

    const timelineCounts = (Array.isArray(timeline) ? timeline : []).reduce((acc: Record<string, number>, ev: any) => {
      const ty = String(ev?.type || "").toLowerCase();
      if (!ty) return acc;
      acc[ty] = (acc[ty] || 0) + 1;
      return acc;
    }, {});

    if (packetJobCount !== approvedJobs.length) {
      reasons.push(`packet jobCount ${packetJobCount} != approved jobs ${approvedJobs.length}`);
    }

    if (packetEvidenceCount !== (Array.isArray(evidence) ? evidence.length : 0)) {
      reasons.push(`packet evidenceCount ${packetEvidenceCount} != evidence rows ${(Array.isArray(evidence) ? evidence.length : 0)}`);
    }

    if ((timelineCounts["field_submitted"] || 0) < 1) {
      reasons.push("missing field_submitted event");
    }
    if ((timelineCounts["incident_closed"] || 0) < 1) {
      reasons.push("missing incident_closed event");
    }

    const expectedApprovedCount = Array.isArray(jobs) ? jobs.length : 0;

    if ((timelineCounts["job_approved"] || 0) < expectedApprovedCount) {
      reasons.push(`expected at least ${expectedApprovedCount} job_approved events`);
    }

    return reasons;
  }, [incident, jobs, evidence, timeline]);

  const hasFieldIssues = truthMismatchReasons.some(r =>
    r.includes("field_submitted") || r.includes("incident_closed")
  );

  const hasOnlyPacketIssues =
    truthMismatchReasons.length > 0 &&
    !hasFieldIssues;

  const truthError = truthMismatchReasons.length > 0
    ? truthMismatchReasons.join(" • ")
    : "";
  const incidentClosed = String(incidentStatus || "").trim().toLowerCase() === "closed";
  const artifactDownloadable = String(artifactHint || "").toLowerCase().includes("ready") || !!lastArtifactFilename;
  const bannerKind =
    hasFieldIssues
      ? "error"
      : incidentClosed && !artifactDownloadable
      ? "info"
      : artifactDownloadable
      ? "success"
      : "";
  // PEAKOPS_SUMMARY_HUMAN_COPY_V1 (2026-04-24)
  // Translate raw backend/internal mismatch reasons into short, operational
  // copy a city/utility ops user can act on. The raw strings stay available
  // in the "Technical details" collapsible so we don't lose debug fidelity.
  const humanizedReasons = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of truthMismatchReasons) {
      const x = String(r || "").toLowerCase();
      let s = "";
      if (x.includes("unassigned")) s = "Some evidence is not assigned to a job";
      else if (x.includes("field_submitted")) s = "Field report has not been submitted";
      else if (x.includes("incident_closed")) s = "Incident has not been closed";
      else if (x.includes("job_approved")) s = "Some jobs are still waiting for approval";
      else if (x.includes("evidencecount")) s = "Packet evidence count is out of date — regenerate to refresh";
      else if (x.includes("jobcount")) s = "Packet job count is out of date — regenerate to refresh";
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }, [truthMismatchReasons]);
  const bannerIcon = bannerKind === "success" ? "✓" : bannerKind === "error" ? "⚠" : bannerKind === "info" ? "ℹ" : "";
  const bannerTitle =
    bannerKind === "error"
      ? "A few steps left before export"
      : bannerKind === "info"
      ? "Ready to finalize the artifact"
      : "Incident finalized";
  const bannerBody =
    bannerKind === "error"
      ? "Finish the items below, then return here to generate the packet."
      : bannerKind === "info"
      ? "All field steps are complete. Generate the artifact to finalize this incident."
      : lastArtifactFilename
      ? `Packet ready: ${lastArtifactFilename}.`
      : "Your incident packet is ready. Use Download Artifact to save it.";

  // PEAKOPS_SUMMARY_POLISH_V1 (2026-04-24)
  // Purely visual pass: aligns Summary with the field/review dark+gold tokens,
  // tightens card spacing, promotes Generate Artifact to the same
  // gold-gradient primary used by NextBestAction/Mark arrived, hides dev
  // tools behind a <details> so prod UI is clean, and preserves orgId on
  // the Back button. No data, backend calls, or state logic touched.
  const bannerPalette =
    bannerKind === "error"
      ? { border: "1px solid rgba(220,60,60,0.35)", background: "rgba(220,60,60,0.08)", color: "#fca5a5" }
      : bannerKind === "info"
      ? { border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", color: "#C8A84E" }
      : { border: "1px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.08)", color: "#86efac" };
  const artifactDisabled = artifactBusy || !orgId || !incidentId;
  const artifactLabel = artifactBusy
    ? "Preparing Artifact…"
    : artifactHint.toLowerCase().includes("ready")
    ? "Download Artifact"
    : artifactHint.toLowerCase().includes("building")
    ? "Artifact Building…"
    : "Generate Artifact";

  return (
    <>
      <main
        className="min-h-screen p-4"
        style={{
          background: "#050505",
          color: "#f5f5f5",
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div className="max-w-6xl mx-auto space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  color: "#C8A84E",
                  textTransform: "uppercase" as const,
                }}
              >
                Incident Summary
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: "#f5f5f5",
                  marginTop: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {incidentId}
              </div>
              {orgId ? (
                <div style={{ fontSize: 11, color: "#6f6f6f", marginTop: 2 }}>
                  Org: <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{orgId}</span>
                </div>
              ) : null}
            </div>
            <button
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
                color: "#b3b3b3",
                flexShrink: 0,
              }}
              onClick={() => router.push(incidentPath(incidentId, orgId))}
            >
              ← Back to Incident
            </button>
          </div>

          {/* PEAKOPS_SUMMARY_BANNER_INSIDE_V1 (2026-04-24)
              Status banner moved inside <main> so it shares the page's
              max-width, padding, and rhythm. Uses an icon + bulleted
              humanized reasons; raw `truthError` stays in a collapsible
              for debugging. */}
          {bannerKind ? (
            <section
              style={{
                borderRadius: 10,
                padding: "14px 16px",
                ...bannerPalette,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                {bannerIcon ? (
                  <div
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      background:
                        bannerKind === "success"
                          ? "rgba(34,197,94,0.18)"
                          : bannerKind === "error"
                          ? "rgba(220,60,60,0.18)"
                          : "rgba(200,168,78,0.18)",
                      color:
                        bannerKind === "success"
                          ? "#86efac"
                          : bannerKind === "error"
                          ? "#fca5a5"
                          : "#C8A84E",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      fontWeight: 800,
                      lineHeight: 1,
                    }}
                  >
                    {bannerIcon}
                  </div>
                ) : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{bannerTitle}</div>
                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, opacity: 0.9 }}>
                    {bannerBody}
                  </div>
                  {bannerKind === "error" && humanizedReasons.length > 0 ? (
                    <ul
                      style={{
                        marginTop: 8,
                        paddingLeft: 16,
                        fontSize: 12,
                        lineHeight: 1.6,
                        listStyle: "disc",
                      }}
                    >
                      {humanizedReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : null}
                  {bannerKind === "success" && (lastArtifactFilename || lastArtifactAt) ? (
                    <div style={{ marginTop: 6, fontSize: 11, opacity: 0.85 }}>
                      {lastArtifactFilename ? (
                        <span style={{ fontFamily: "ui-monospace, monospace" }}>
                          {lastArtifactFilename}
                        </span>
                      ) : null}
                      {lastArtifactFilename && lastArtifactAt ? " • " : ""}
                      {lastArtifactAt || ""}
                    </div>
                  ) : null}
                  {truthError ? (
                    <details style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
                      <summary style={{ cursor: "pointer" }}>Technical details</summary>
                      <div
                        style={{
                          marginTop: 6,
                          fontFamily: "ui-monospace, monospace",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {truthError}
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {/* PEAKOPS_SUMMARY_UNASSIGNED_WARNING_V1 (2026-04-24)
              Customer-facing warning when evidence still needs to be
              assigned. The dev-only "Fix unassigned" affordance still
              lives inside the Evidence by Job section. This banner gives
              an ops user one obvious next action without exposing
              backend wording. */}
          {unassignedEvidenceCount > 0 ? (
            <section
              style={{
                borderRadius: 10,
                padding: "12px 16px",
                border: "1px solid rgba(200,168,78,0.35)",
                background: "rgba(200,168,78,0.08)",
                color: "#C8A84E",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: "rgba(200,168,78,0.18)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 800,
                  lineHeight: 1,
                }}
              >
                ⚠
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {unassignedEvidenceCount} evidence item
                  {unassignedEvidenceCount === 1 ? "" : "s"} need
                  {unassignedEvidenceCount === 1 ? "s" : ""} to be assigned before export.
                </div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  Open the incident&rsquo;s Evidence tab to attach each item to a job.
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  router.push(incidentPath(incidentId, orgId, { hash: "evidence" }))
                }
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: "1px solid rgba(200,168,78,0.4)",
                  background: "rgba(200,168,78,0.15)",
                  color: "#C8A84E",
                  flexShrink: 0,
                }}
              >
                Assign Evidence →
              </button>
            </section>
          ) : null}

          {/* Transient banners */}
          {!err && demoAuthBypassMsg ? (
            <div
              style={{
                fontSize: 12,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(200,168,78,0.3)",
                background: "rgba(200,168,78,0.08)",
                color: "#C8A84E",
              }}
            >
              {demoAuthBypassMsg}
            </div>
          ) : null}
          {!err && artifactToast ? (
            <div
              style={{
                fontSize: 12,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(34,197,94,0.3)",
                background: "rgba(34,197,94,0.08)",
                color: "#86efac",
              }}
            >
              {artifactToast}
            </div>
          ) : null}

          {/* Incident Status + Artifact */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
            <div className="flex items-center justify-between gap-3">
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#C8A84E",
                  textTransform: "uppercase" as const,
                }}
              >
                Incident Status
              </div>
              <span className={"text-[11px] px-2 py-0.5 rounded-full border " + incidentStatusPill(incidentStatus)}>
                {incidentStatusLabel(incidentStatus)}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={artifactDisabled}
                onClick={() => { void handleArtifactDownload(); }}
                title={artifactHint}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: "0.02em",
                  cursor: artifactDisabled ? "not-allowed" : "pointer",
                  border: artifactDisabled ? "1px solid #1c1c1c" : "none",
                  background: artifactDisabled ? "#101010" : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                  color: artifactDisabled ? "#6f6f6f" : "#050505",
                  boxShadow: artifactDisabled ? "none" : "0 2px 12px rgba(200,168,78,0.20)",
                  transition: "background 120ms ease",
                }}
              >
                {artifactLabel}
              </button>
              <div style={{ fontSize: 12, color: "#b3b3b3", lineHeight: 1.5, flex: 1, minWidth: 200 }}>
                {artifactHint}
              </div>
            </div>
            {lastArtifactFilename ? (
              <div style={{ marginTop: 10, fontSize: 11, color: "#6f6f6f" }}>
                Last artifact:{" "}
                <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{lastArtifactFilename}</span>
                {lastArtifactAt ? ` • ${lastArtifactAt}` : ""}
              </div>
            ) : null}
            <div
              className="mt-3 flex flex-wrap gap-4"
              style={{ fontSize: 11, color: "#6f6f6f" }}
            >
              <span>
                Evidence:{" "}
                <span style={{ color: "#f5f5f5", fontWeight: 600 }}>
                  {incident?.packetMeta?.evidenceCount ?? packetEvidenceCount}
                </span>
              </span>
              <span>
                Jobs:{" "}
                <span style={{ color: "#f5f5f5", fontWeight: 600 }}>
                  {incident?.packetMeta?.jobCount ?? packetJobCount}
                </span>
              </span>
            </div>
          </section>

          {/* Jobs Breakdown */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.1em",
                color: "#C8A84E",
                textTransform: "uppercase" as const,
              }}
            >
              Jobs Breakdown
            </div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {Object.entries(statusCounts).map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    borderRadius: 8,
                    border: "1px solid #1c1c1c",
                    background: "#050505",
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      letterSpacing: "0.08em",
                      color: "#6f6f6f",
                      textTransform: "uppercase" as const,
                    }}
                  >
                    {k}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5", marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Evidence by Job */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#C8A84E",
                  textTransform: "uppercase" as const,
                }}
              >
                Evidence by Job
              </div>
              {unassignedEvidenceCount > 0 ? (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#C8A84E",
                    padding: "2px 8px",
                    borderRadius: 999,
                    border: "1px solid rgba(200,168,78,0.3)",
                    background: "rgba(200,168,78,0.08)",
                  }}
                >
                  {unassignedEvidenceCount} unassigned
                </span>
              ) : null}
            </div>
            {(isDemoMode || process.env.NODE_ENV !== "production") ? (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", fontSize: 10, color: "#6f6f6f" }}>Dev tools</summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => refreshVisibleThumbsDebounced()}
                  >
                    Refresh thumbnails
                  </button>
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => forceRemintVisibleThumbs()}
                  >
                    Force remint URLs
                  </button>
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => setThumbDebugOverlay((v) => !v)}
                  >
                    {thumbDebugOverlay ? "Hide thumb debug" : "Show thumb debug"}
                  </button>
                  {unassignedEvidenceCount > 0 ? (
                    <button
                      type="button"
                      style={{
                        fontSize: 10,
                        padding: "3px 8px",
                        borderRadius: 4,
                        border: "1px solid rgba(200,168,78,0.3)",
                        background: "rgba(200,168,78,0.08)",
                        color: "#C8A84E",
                        fontWeight: 600,
                        cursor: fixUnassignedBusy ? "not-allowed" : "pointer",
                        opacity: fixUnassignedBusy ? 0.5 : 1,
                      }}
                      onClick={() => { void fixUnassignedEvidence(); }}
                      disabled={fixUnassignedBusy}
                    >
                      {fixUnassignedBusy ? "Fixing…" : "Fix unassigned (dev)"}
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
            <div className="mt-3 space-y-3">
              {Object.keys(evidenceByJob).length === 0 ? (
                <div style={{ fontSize: 13, color: "#6f6f6f" }}>No evidence found.</div>
              ) : Object.entries(evidenceByJob).map(([jobId, list]) => {
                const job = jobs.find((j) => String(j?.id || j?.jobId || "") === jobId);
                const title = job ? String(job.title || jobId) : (jobId === "unassigned" ? "Unassigned" : jobId);
                const isUnassigned = jobId === "unassigned";
                return (
                  <div key={jobId} style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#050505", padding: "10px 12px" }}>
                    <div className="flex items-center justify-between gap-2">
                      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          aria-hidden
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: isUnassigned ? "#C8A84E" : "#22c55e",
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 13,
                            color: "#f5f5f5",
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {title}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "#b3b3b3",
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "1px solid #1c1c1c",
                          background: "#0b0b0b",
                          flexShrink: 0,
                        }}
                      >
                        {list.length} item{list.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2 overflow-x-auto">
                      {list.slice(0, 8).map((ev) => {
                        const id = String(ev.id || "");
                        const u = thumbUrl[id];
                        return (
                          <div
                            key={id}
                            className="relative min-w-[110px] w-[110px] aspect-[4/3] rounded-lg overflow-hidden"
                            style={{ border: "1px solid #1a1a1a", background: "#000" }}
                          >
                            {u ? (
                              <img
                                src={u}
                                className="w-full h-full object-cover"
                                onLoad={() => {
                                  setThumbStatusById((m) => ({ ...m, [id]: 200 }));
                                  setThumbErrById((m) => ({ ...m, [id]: "" }));
                                }}
                                onError={() => { void renewThumbOnce(ev, u); }}
                              />
                            ) : (
                              <div
                                className="w-full h-full flex items-center justify-center text-[10px] text-center px-1"
                                style={{ color: "#6f6f6f" }}
                              >
                                {thumbErrById[id] ? "Unavailable" : "Loading…"}
                              </div>
                            )}
                            {process.env.NODE_ENV !== "production" && thumbErrById[id] ? (
                              <div
                                className="absolute left-1 right-1 bottom-1 text-[9px] truncate bg-black/70 px-1 py-0.5 rounded"
                                style={{ color: "#fca5a5", border: "1px solid rgba(248,113,113,0.3)" }}
                              >
                                {thumbErrById[id]}
                              </div>
                            ) : null}
                            {process.env.NODE_ENV !== "production" && thumbDebugOverlay ? (
                              <div
                                className="absolute left-1 right-1 top-1 text-[9px] bg-black/65 px-1 py-0.5 rounded"
                                style={{ color: "#a5f3fc", border: "1px solid rgba(103,232,249,0.3)" }}
                              >
                                <div className="truncate">id={id}</div>
                                <div className="truncate">bucket={String(thumbBucketById[id] || "")}</div>
                                <div className="truncate">path={String(thumbPathById[id] || "")}</div>
                                <div className="truncate">mint_http={String(thumbStatusById[id] || 0)}</div>
                                <div className="truncate">mint_error={String(thumbMintErrorById[id] || "-")}</div>
                                <div className="truncate">probe_http={String(thumbProbeStatusById[id] || "-")}</div>
                                <div className="truncate">probe_error={String(thumbProbeErrorById[id] || "-")}</div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Timeline Highlights */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.1em",
                color: "#C8A84E",
                textTransform: "uppercase" as const,
              }}
            >
              Timeline Highlights
            </div>
            <div className="mt-3 space-y-2">
              {timelineHighlights.length === 0 ? (
                <div style={{ fontSize: 13, color: "#6f6f6f" }}>No highlights yet.</div>
              ) : timelineHighlights.map((t) => {
                const ty = String(t.type || "").toLowerCase();
                const tone =
                  ty === "incident_closed" || ty === "job_approved"
                    ? "#22c55e"
                    : ty === "field_submitted"
                    ? "#C8A84E"
                    : "#6f6f6f";
                return (
                  <div
                    key={t.id}
                    style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#050505", padding: "8px 12px" }}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <span
                        aria-hidden
                        style={{ width: 6, height: 6, borderRadius: 999, background: tone, flexShrink: 0 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 500 }}>
                          {String(t.type || "event")}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6f6f6f",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          actor: {String(t.actor || "system")}
                          {t.refId ? ` • ref: ${String(t.refId)}` : ""}
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: "#6f6f6f", flexShrink: 0 }}>
                      {fmtAgo(t.occurredAt?._seconds)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {loading ? <div style={{ fontSize: 11, color: "#6f6f6f" }}>Refreshing summary…</div> : null}
        </div>
      </main>
    </>
  );
  }
